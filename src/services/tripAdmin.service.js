const httpError = require('../utils/httpError');
const { toMinutes, todayIST, addMinutesToDateTime } = require('../utils/time');

// Absolute [start, end) window in minutes since epoch-day for a trip
const tripWindow = (travelDate, dep, arr, fallbackDuration) => {
  const day = Math.floor(Date.parse(`${travelDate}T00:00:00Z`) / 60000);
  const start = day + toMinutes(dep);
  let duration = arr ? toMinutes(arr) - toMinutes(dep) : fallbackDuration;
  while (duration <= 0) duration += 1440;
  return [start, start + duration];
};

/**
 * Throws 409 if the vehicle already runs a non-cancelled trip overlapping this one
 * (checks the previous, same and next day to catch overnight trips).
 */
const assertNoVehicleConflict = async (conn, { vehicle_id, travel_date, departure_time, arrival_time, duration }, excludeTripId = 0) => {
  const [mine0, mine1] = tripWindow(travel_date, departure_time, arrival_time, duration || 60);
  const [others] = await conn.query(
    `SELECT t.id, t.travel_date, t.departure_time, t.arrival_time, r.duration_minutes, fl.city AS from_city, tl.city AS to_city
     FROM trips t JOIN routes r ON r.id = t.route_id
     JOIN locations fl ON fl.id = r.from_location_id JOIN locations tl ON tl.id = r.to_location_id
     WHERE t.vehicle_id = ? AND t.id <> ? AND t.status <> 'cancelled'
       AND t.travel_date BETWEEN DATE_SUB(?, INTERVAL 1 DAY) AND DATE_ADD(?, INTERVAL 1 DAY)`,
    [vehicle_id, excludeTripId, travel_date, travel_date]
  );
  for (const o of others) {
    const [a, b] = tripWindow(o.travel_date, o.departure_time, o.arrival_time, o.duration_minutes || 60);
    if (mine0 < b && a < mine1) {
      throw httpError(409, `This vehicle is already running ${o.from_city} → ${o.to_city} on ${o.travel_date} at ${o.departure_time.slice(0, 5)}`);
    }
  }
};

/**
 * Validates and inserts a trip. data: { route_id, vehicle_id, travel_date, departure_time,
 * arrival_time?, fare_adjustment_pct?, status?, notes?, schedule_id? }
 */
const createTrip = async (conn, data, userId = null, { allowPast = false } = {}) => {
  const [routes] = await conn.query('SELECT id, is_active, duration_minutes FROM routes WHERE id = ? AND deleted_at IS NULL', [data.route_id]);
  if (!routes.length) throw httpError(400, 'Route not found');
  if (!routes[0].is_active) throw httpError(400, 'Trips cannot be created on an inactive route');
  const [[{ stops }]] = await conn.query('SELECT COUNT(*) AS stops FROM route_stops WHERE route_id = ? AND is_active = 1', [data.route_id]);
  if (stops < 2) throw httpError(400, 'Add at least two stops to this route before creating trips');

  const [vehicles] = await conn.query('SELECT id, is_active, seat_layout_id FROM vehicles WHERE id = ? AND deleted_at IS NULL', [data.vehicle_id]);
  if (!vehicles.length) throw httpError(400, 'Vehicle not found');
  if (!vehicles[0].is_active) throw httpError(400, 'Trips cannot be created with an inactive vehicle');
  if (!vehicles[0].seat_layout_id) throw httpError(400, 'Assign a seat layout to this vehicle first');

  if (!allowPast && data.travel_date < todayIST()) throw httpError(400, 'Travel date cannot be in the past');
  const pct = Number(data.fare_adjustment_pct || 0);
  if (!Number.isFinite(pct) || pct < -90 || pct > 300) throw httpError(400, 'Fare adjustment must be between -90% and +300%');

  // Default arrival from the route's configured duration
  const arrival = data.arrival_time || addMinutesToDateTime(data.travel_date, data.departure_time, routes[0].duration_minutes || 0).slice(11);
  await assertNoVehicleConflict(conn, { ...data, arrival_time: arrival, duration: routes[0].duration_minutes });

  const row = {
    route_id: data.route_id, vehicle_id: data.vehicle_id, schedule_id: data.schedule_id || null,
    travel_date: data.travel_date, departure_time: data.departure_time, arrival_time: arrival,
    fare_adjustment_pct: pct, status: data.status || 'scheduled', notes: data.notes || null, created_by: userId,
  };
  const [r] = await conn.query('INSERT INTO trips SET ?', [row]);
  return { id: r.insertId, ...row };
};

// Dates between from..to (inclusive) whose weekday is in `days` (0=Sun)
const datesForSchedule = (from, to, days) => {
  const out = [];
  const set = new Set(String(days).split(',').map(Number));
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86400000) {
    const d = new Date(t);
    if (set.has(d.getUTCDay())) out.push(d.toISOString().slice(0, 10));
  }
  return out;
};

/**
 * Creates trips for a schedule between from..to. Existing / conflicting slots are skipped.
 */
const generateTripsForSchedule = async (conn, schedule, from, to, userId = null, opts = {}) => {
  const start = from > schedule.start_date ? from : schedule.start_date;
  const end = to < schedule.end_date ? to : schedule.end_date;
  const created = []; const skipped = [];
  for (const date of datesForSchedule(start, end, schedule.days_of_week)) {
    const [exists] = await conn.query(
      'SELECT id FROM trips WHERE vehicle_id = ? AND travel_date = ? AND departure_time = ?',
      [schedule.vehicle_id, date, schedule.departure_time]
    );
    if (exists.length) { skipped.push({ date, reason: 'already exists' }); continue; }
    try {
      const trip = await createTrip(conn, {
        route_id: schedule.route_id, vehicle_id: schedule.vehicle_id, schedule_id: schedule.id,
        travel_date: date, departure_time: schedule.departure_time, arrival_time: schedule.arrival_time,
        fare_adjustment_pct: schedule.fare_adjustment_pct,
      }, userId, opts);
      created.push(trip.id);
    } catch (err) {
      if (!err.statusCode) throw err;
      skipped.push({ date, reason: err.message });
    }
  }
  return { created: created.length, skipped };
};

module.exports = { createTrip, assertNoVehicleConflict, generateTripsForSchedule, datesForSchedule };
