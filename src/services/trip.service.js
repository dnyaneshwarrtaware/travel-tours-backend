const { pool } = require('../config/database');
const httpError = require('../utils/httpError');
const { tripStopSchedule, nowIST } = require('../utils/time');

const BOOKABLE_TRIP_STATUSES = ['scheduled', 'boarding'];

// Trip-level fare adjustment (e.g. -10% for a non-AC service). Whole rupees.
const adjustedFare = (baseFare, pct = 0) => Math.max(0, Math.round(Number(baseFare) * (100 + Number(pct || 0)) / 100));

const getRouteStops = async (routeId, { activeOnly = true, conn = pool } = {}) => {
  const [rows] = await conn.query(
    `SELECT rs.id, rs.route_id, rs.location_id, rs.stop_name, rs.address, rs.landmark, rs.stop_order,
            rs.arrival_time, rs.departure_time, rs.boarding_allowed, rs.dropping_allowed, rs.is_active,
            l.name AS location_name, l.city AS location_city
     FROM route_stops rs JOIN locations l ON l.id = rs.location_id
     WHERE rs.route_id = ? ${activeOnly ? 'AND rs.is_active = 1' : ''}
     ORDER BY rs.is_active DESC, rs.stop_order ASC, rs.id ASC`,
    [routeId]
  );
  return rows;
};

const getRouteFares = async (routeId, conn = pool) => {
  const [rows] = await conn.query(
    'SELECT id, from_stop_id, to_stop_id, fare FROM route_fares WHERE route_id = ? AND is_active = 1',
    [routeId]
  );
  return rows;
};

const TRIP_SELECT = `
  SELECT t.*, r.name AS route_name, r.slug AS route_slug, r.is_active AS route_active, r.deleted_at AS route_deleted_at,
         r.distance_km, r.duration_minutes,
         fl.city AS from_city, tl.city AS to_city,
         v.name AS vehicle_name, v.registration_number, v.type AS vehicle_type, v.is_ac, v.seat_type,
         v.seat_layout_id, v.capacity, v.amenities, v.is_active AS vehicle_active, v.deleted_at AS vehicle_deleted_at,
         o.name AS operator_name
  FROM trips t
  JOIN routes r ON r.id = t.route_id
  JOIN locations fl ON fl.id = r.from_location_id
  JOIN locations tl ON tl.id = r.to_location_id
  JOIN vehicles v ON v.id = t.vehicle_id
  LEFT JOIN operators o ON o.id = v.operator_id`;

const getTripCore = async (tripId, { conn = pool, forUpdate = false } = {}) => {
  if (forUpdate) {
    // Serialise seat operations per trip
    await conn.query('SELECT id FROM trips WHERE id = ? FOR UPDATE', [tripId]);
  }
  const [rows] = await conn.query(`${TRIP_SELECT} WHERE t.id = ?`, [tripId]);
  if (!rows.length) throw httpError(404, 'Trip not found');
  return rows[0];
};

// Seats that can be sold on a trip, and how many are taken (booked/blocked/live locks)
const seatCounts = async (tripIds, conn = pool) => {
  if (!tripIds.length) return {};
  const [rows] = await conn.query(
    `SELECT t.id AS trip_id,
            (SELECT COUNT(*) FROM seat_layout_seats s WHERE s.seat_layout_id = v.seat_layout_id AND s.is_active = 1) AS total_seats,
            (SELECT COUNT(*) FROM trip_seats ts
               JOIN seat_layout_seats s2 ON s2.id = ts.seat_id AND s2.is_active = 1
               WHERE ts.trip_id = t.id AND (ts.status <> 'LOCKED' OR ts.locked_until > NOW())) AS taken_seats
     FROM trips t JOIN vehicles v ON v.id = t.vehicle_id
     WHERE t.id IN (?)`,
    [tripIds]
  );
  const map = {};
  rows.forEach(r => { map[r.trip_id] = { total_seats: r.total_seats, available_seats: Math.max(0, r.total_seats - r.taken_seats) }; });
  return map;
};

// Reasons a trip cannot be booked (empty array = bookable)
const tripBlockers = (trip) => {
  const reasons = [];
  if (!BOOKABLE_TRIP_STATUSES.includes(trip.status)) reasons.push(`Trip is ${trip.status}`);
  if (!trip.route_active || trip.route_deleted_at) reasons.push('Route is inactive');
  if (!trip.vehicle_active || trip.vehicle_deleted_at) reasons.push('Vehicle is inactive');
  if (!trip.seat_layout_id) reasons.push('Vehicle has no seat layout');
  return reasons;
};

const assertTripBookable = (trip) => {
  const reasons = tripBlockers(trip);
  if (reasons.length) throw httpError(400, `This trip cannot be booked: ${reasons[0].toLowerCase()}`);
};

/**
 * Validates a boarding/dropping pair on a trip and returns the server-side fare.
 * `schedule` is the result of tripStopSchedule for the trip's active stops.
 */
const resolveSegment = async (trip, boardingStopId, droppingStopId, { conn = pool, schedule = null, enforceDeparture = true } = {}) => {
  const stops = schedule || tripStopSchedule(trip, await getRouteStops(trip.route_id, { conn }));
  const boarding = stops.find(s => s.id === Number(boardingStopId));
  const dropping = stops.find(s => s.id === Number(droppingStopId));
  if (!boarding || !dropping) throw httpError(400, 'Boarding and dropping points must be active stops on this route');
  if (!boarding.boarding_allowed) throw httpError(400, `Boarding is not allowed at ${boarding.stop_name}`);
  if (!dropping.dropping_allowed) throw httpError(400, `Dropping is not allowed at ${dropping.stop_name}`);
  if (boarding.stop_order >= dropping.stop_order) throw httpError(400, 'Boarding point must come before the dropping point');

  if (enforceDeparture) {
    const boardingAt = boarding.departure_at || `${trip.travel_date} ${trip.departure_time}`;
    if (boardingAt <= nowIST()) throw httpError(400, 'This bus has already departed from the selected boarding point');
  }

  const [fares] = await conn.query(
    'SELECT fare FROM route_fares WHERE route_id = ? AND from_stop_id = ? AND to_stop_id = ? AND is_active = 1',
    [trip.route_id, boarding.id, dropping.id]
  );
  if (!fares.length) throw httpError(400, `Fare is not configured for ${boarding.stop_name} → ${dropping.stop_name}`);

  return {
    boarding,
    dropping,
    base_fare: fares[0].fare,
    fare_per_seat: adjustedFare(fares[0].fare, trip.fare_adjustment_pct),
  };
};

const publicTrip = (trip) => ({
  id: trip.id,
  route_id: trip.route_id,
  route_name: trip.route_name || `${trip.from_city} → ${trip.to_city}`,
  route_slug: trip.route_slug,
  from_city: trip.from_city,
  to_city: trip.to_city,
  travel_date: trip.travel_date,
  departure_time: trip.departure_time,
  arrival_time: trip.arrival_time,
  status: trip.status,
  fare_adjustment_pct: trip.fare_adjustment_pct,
  vehicle: {
    id: trip.vehicle_id,
    name: trip.vehicle_name,
    registration_number: trip.registration_number,
    is_ac: !!trip.is_ac,
    seat_type: trip.seat_type,
    type: trip.vehicle_type,
    amenities: typeof trip.amenities === 'string' ? JSON.parse(trip.amenities || '[]') : (trip.amenities || []),
    operator_name: trip.operator_name,
  },
});

// Full trip detail for the booking page: stops with trip times + all segment fares
const getTripDetail = async (tripId) => {
  const trip = await getTripCore(tripId);
  const schedule = tripStopSchedule(trip, await getRouteStops(trip.route_id));
  const fares = await getRouteFares(trip.route_id);
  const counts = (await seatCounts([trip.id]))[trip.id] || { total_seats: 0, available_seats: 0 };
  return {
    ...publicTrip(trip),
    bookable: tripBlockers(trip).length === 0,
    blockers: tripBlockers(trip),
    ...counts,
    stops: schedule.map(s => ({
      id: s.id, stop_name: s.stop_name, location_id: s.location_id, location_city: s.location_city,
      landmark: s.landmark, address: s.address, stop_order: s.stop_order,
      boarding_allowed: !!s.boarding_allowed, dropping_allowed: !!s.dropping_allowed,
      arrival_at: s.arrival_at, departure_at: s.departure_at,
    })),
    fares: fares.map(f => ({ from_stop_id: f.from_stop_id, to_stop_id: f.to_stop_id, fare: adjustedFare(f.fare, trip.fare_adjustment_pct) })),
  };
};

/**
 * Search bookable trips on a date that pass through `from` (boarding allowed)
 * and later `to` (dropping allowed). from/to are location ids or slugs.
 */
const searchTrips = async ({ from, to, date }) => {
  const [locs] = await pool.query(
    'SELECT id, slug, city FROM locations WHERE (id = ? OR slug = ? OR id = ? OR slug = ?) AND is_active = 1',
    [Number(from) || 0, String(from), Number(to) || 0, String(to)]
  );
  const fromLoc = locs.find(l => l.id === Number(from) || l.slug === String(from));
  const toLoc = locs.find(l => l.id === Number(to) || l.slug === String(to));
  if (!fromLoc || !toLoc) throw httpError(404, 'Location not found');
  if (fromLoc.id === toLoc.id) throw httpError(400, 'From and To cannot be the same');

  const [rows] = await pool.query(
    `${TRIP_SELECT}
     WHERE t.travel_date = ? AND t.status IN (?)
       AND r.is_active = 1 AND r.deleted_at IS NULL AND v.is_active = 1 AND v.deleted_at IS NULL
       AND v.seat_layout_id IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM route_stops bs
         JOIN route_stops ds ON ds.route_id = bs.route_id AND ds.location_id = ? AND ds.is_active = 1
                             AND ds.dropping_allowed = 1 AND ds.stop_order > bs.stop_order
         WHERE bs.route_id = t.route_id AND bs.location_id = ? AND bs.is_active = 1 AND bs.boarding_allowed = 1)
     ORDER BY t.departure_time ASC`,
    [date, BOOKABLE_TRIP_STATUSES, toLoc.id, fromLoc.id]
  );
  if (!rows.length) return { from: fromLoc, to: toLoc, date, trips: [] };

  const counts = await seatCounts(rows.map(r => r.id));
  const routeIds = [...new Set(rows.map(r => r.route_id))];
  const stopsByRoute = {};
  const faresByRoute = {};
  await Promise.all(routeIds.map(async (rid) => {
    stopsByRoute[rid] = await getRouteStops(rid);
    faresByRoute[rid] = await getRouteFares(rid);
  }));

  const now = nowIST();
  const trips = [];
  for (const trip of rows) {
    const schedule = tripStopSchedule(trip, stopsByRoute[trip.route_id]);
    const boardOptions = schedule.filter(s => s.location_id === fromLoc.id && s.boarding_allowed);
    const dropOptions = schedule.filter(s => s.location_id === toLoc.id && s.dropping_allowed);

    // Best (cheapest) valid segment that has not departed yet
    let best = null;
    for (const b of boardOptions) {
      const boardAt = b.departure_at || `${trip.travel_date} ${trip.departure_time}`;
      if (boardAt <= now) continue;
      for (const d of dropOptions) {
        if (d.stop_order <= b.stop_order) continue;
        const f = faresByRoute[trip.route_id].find(x => x.from_stop_id === b.id && x.to_stop_id === d.id);
        if (!f) continue;
        const fare = adjustedFare(f.fare, trip.fare_adjustment_pct);
        if (!best || fare < best.fare) best = { b, d, fare };
      }
    }
    if (!best) continue;

    const depAt = best.b.departure_at || `${trip.travel_date} ${trip.departure_time}`;
    const arrAt = best.d.arrival_at;
    const durationMinutes = (best.d.arrival_offset ?? best.d.departure_offset) - (best.b.departure_offset ?? 0);

    trips.push({
      ...publicTrip(trip),
      ...counts[trip.id],
      boarding_stop: { id: best.b.id, stop_name: best.b.stop_name, departure_at: depAt },
      dropping_stop: { id: best.d.id, stop_name: best.d.stop_name, arrival_at: arrAt },
      duration_minutes: durationMinutes,
      starting_fare: best.fare,
      stops: schedule.map(s => ({ id: s.id, stop_name: s.stop_name, location_city: s.location_city, arrival_at: s.arrival_at, departure_at: s.departure_at })),
    });
  }
  return { from: fromLoc, to: toLoc, date, trips };
};

module.exports = {
  BOOKABLE_TRIP_STATUSES, adjustedFare, getRouteStops, getRouteFares, getTripCore, getTripDetail,
  seatCounts, tripBlockers, assertTripBookable, resolveSegment, searchTrips, publicTrip,
};
