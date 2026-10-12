const router = require('express').Router();
const { body, param, query } = require('express-validator');
const validate = require('../../middleware/validate');
const { requirePermission } = require('../../middleware/auth');
const { pool, withTransaction } = require('../../config/database');
const { success, error, paginated, buildPaginationMeta } = require('../../utils/response');
const { pagination, diff, updateClause } = require('../../utils/admin');
const { isValidDate, isValidTime, normalizeTime } = require('../../utils/time');
const { audit } = require('../../services/audit.service');
const { createTrip, assertNoVehicleConflict } = require('../../services/tripAdmin.service');
const { getTripDetail, seatCounts } = require('../../services/trip.service');
const { getSeatMap, setSeatsBlocked } = require('../../services/seat.service');
const { cancelBooking } = require('../../services/booking.service');

const TRIP_STATUSES = ['scheduled', 'boarding', 'running', 'completed', 'cancelled'];
const TRANSITIONS = {
  scheduled: ['boarding', 'running', 'completed', 'cancelled'],
  boarding: ['scheduled', 'running', 'completed', 'cancelled'],
  running: ['completed'],
  completed: [],
  cancelled: [],
};

const tripFields = (partial = false) => {
  const r = (c) => (partial ? c.optional() : c);
  return [
    r(body('route_id')).isInt({ min: 1 }).withMessage('Select a route').toInt(),
    r(body('vehicle_id')).isInt({ min: 1 }).withMessage('Select a vehicle').toInt(),
    r(body('travel_date')).custom(isValidDate).withMessage('Select a valid travel date'),
    r(body('departure_time')).custom(isValidTime).withMessage('Enter a valid departure time').customSanitizer(normalizeTime),
    body('arrival_time').optional({ values: 'falsy' }).custom(isValidTime).withMessage('Enter a valid arrival time').customSanitizer(normalizeTime),
    body('fare_adjustment_pct').optional({ values: 'falsy' }).isFloat({ min: -90, max: 300 }).withMessage('Fare adjustment must be between -90 and 300%'),
    body('notes').optional({ nullable: true }).isString().isLength({ max: 1000 }),
  ];
};

// GET /api/admin/trips?date_from=&date_to=&route_id=&vehicle_id=&status=
router.get('/', validate([
  query('date_from').optional({ values: 'falsy' }).custom(isValidDate),
  query('date_to').optional({ values: 'falsy' }).custom(isValidDate),
]), async (req, res, next) => {
  try {
    const { page, limit, offset } = pagination(req.query, 25);
    const { date_from, date_to, route_id, vehicle_id, status } = req.query;
    const cond = []; const params = [];
    if (date_from) { cond.push('t.travel_date >= ?'); params.push(date_from); }
    if (date_to) { cond.push('t.travel_date <= ?'); params.push(date_to); }
    if (route_id) { cond.push('t.route_id = ?'); params.push(route_id); }
    if (vehicle_id) { cond.push('t.vehicle_id = ?'); params.push(vehicle_id); }
    if (status && TRIP_STATUSES.includes(status)) { cond.push('t.status = ?'); params.push(status); }
    const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';

    const [rows] = await pool.query(
      `SELECT t.*, r.name AS route_name, fl.city AS from_city, tl.city AS to_city,
              v.name AS vehicle_name, v.registration_number,
              (SELECT COUNT(*) FROM bookings b WHERE b.trip_id = t.id AND b.booking_status IN ('pending','reserved','confirmed','completed')) AS booking_count,
              (SELECT COALESCE(SUM(b.total_amount),0) FROM bookings b WHERE b.trip_id = t.id AND b.payment_status = 'paid') AS paid_amount
       FROM trips t JOIN routes r ON r.id = t.route_id
       JOIN locations fl ON fl.id = r.from_location_id JOIN locations tl ON tl.id = r.to_location_id
       JOIN vehicles v ON v.id = t.vehicle_id
       ${where} ORDER BY t.travel_date ${date_from ? 'ASC' : 'DESC'}, t.departure_time ASC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM trips t ${where}`, params);
    const counts = await seatCounts(rows.map(r => r.id));
    return paginated(res, rows.map(r => ({ ...r, ...counts[r.id] })), buildPaginationMeta(total, page, limit));
  } catch (err) { next(err); }
});

// GET /api/admin/trips/:id - detail, seat map with booking refs, passenger manifest
router.get('/:id', validate([param('id').isInt().toInt()]), async (req, res, next) => {
  try {
    const trip = await getTripDetail(req.params.id);
    const seatMap = await getSeatMap(req.params.id, null, { includeBookingRefs: true });
    const [manifest] = await pool.query(
      `SELECT b.id AS booking_id, b.booking_number, b.booking_status, b.payment_status, b.payment_method, b.contact_phone,
              bp.name, bp.age, bp.gender, s.seat_number, bs.stop_name AS boarding, ds.stop_name AS dropping
       FROM bookings b JOIN booking_passengers bp ON bp.booking_id = b.id
       JOIN seat_layout_seats s ON s.id = bp.seat_id
       JOIN route_stops bs ON bs.id = b.boarding_stop_id JOIN route_stops ds ON ds.id = b.dropping_stop_id
       WHERE b.trip_id = ? AND b.booking_status <> 'cancelled'
       ORDER BY s.deck, s.row_no, s.col_no`,
      [req.params.id]
    );
    const [[raw]] = await pool.query('SELECT notes, created_at, schedule_id FROM trips WHERE id = ?', [req.params.id]);
    return success(res, { ...trip, ...raw, seat_map: seatMap, manifest });
  } catch (err) { next(err); }
});

router.post('/', requirePermission('trips.manage'), validate(tripFields()), async (req, res, next) => {
  try {
    const trip = await withTransaction(async (conn) => {
      const t = await createTrip(conn, req.body, req.user.id);
      await audit(req, { action: 'trip.create', module: 'trips', recordId: t.id, newValues: t }, conn);
      return t;
    });
    return success(res, trip, 'Trip created', 201);
  } catch (err) { next(err); }
});

// PUT /api/admin/trips/:id - route/vehicle/date are locked once the trip has active bookings
router.put('/:id', requirePermission('trips.manage'), validate([param('id').isInt().toInt(), ...tripFields(true)]), async (req, res, next) => {
  try {
    await withTransaction(async (conn) => {
      const [rows] = await conn.query('SELECT * FROM trips WHERE id = ? FOR UPDATE', [req.params.id]);
      if (!rows.length) throw Object.assign(new Error('Trip not found'), { statusCode: 404 });
      const trip = rows[0];
      if (['completed', 'cancelled'].includes(trip.status)) throw Object.assign(new Error(`A ${trip.status} trip cannot be edited`), { statusCode: 400 });

      const data = {};
      ['route_id', 'vehicle_id', 'travel_date', 'departure_time', 'arrival_time', 'fare_adjustment_pct', 'notes'].forEach(k => {
        if (req.body[k] !== undefined) data[k] = req.body[k] === '' ? null : req.body[k];
      });
      const { oldValues, newValues, changed } = diff(trip, data);
      if (!changed) return;

      const [[{ n }]] = await conn.query(
        "SELECT COUNT(*) AS n FROM bookings WHERE trip_id = ? AND booking_status IN ('pending','reserved','confirmed')", [trip.id]
      );
      const locked = ['route_id', 'vehicle_id', 'travel_date'].filter(k => k in newValues);
      if (n > 0 && locked.length) {
        throw Object.assign(new Error('Route, vehicle and date cannot be changed while the trip has active bookings'), { statusCode: 400 });
      }
      const merged = { ...trip, ...data };
      if (['vehicle_id', 'travel_date', 'departure_time', 'arrival_time'].some(k => k in newValues)) {
        const [[route]] = await conn.query('SELECT duration_minutes FROM routes WHERE id = ?', [merged.route_id]);
        await assertNoVehicleConflict(conn, { ...merged, duration: route?.duration_minutes }, trip.id);
      }
      const { sql, values } = updateClause(data);
      await conn.query(`UPDATE trips SET ${sql} WHERE id = ?`, [...values, trip.id]);
      await audit(req, { action: 'trip.update', module: 'trips', recordId: trip.id, oldValues, newValues }, conn);
    });
    return success(res, null, 'Trip updated');
  } catch (err) { next(err); }
});

// PATCH /api/admin/trips/:id/status { status, reason }
router.patch('/:id/status', requirePermission('trips.manage'), validate([
  param('id').isInt().toInt(),
  body('status').isIn(TRIP_STATUSES).withMessage('Invalid trip status'),
]), async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT * FROM trips WHERE id = ?', [req.params.id]);
    if (!rows.length) return error(res, 'Trip not found', 404);
    const trip = rows[0];
    const next_ = req.body.status;
    if (!TRANSITIONS[trip.status].includes(next_)) return error(res, `Cannot change a ${trip.status} trip to ${next_}`, 400);

    let cancelled = 0;
    if (next_ === 'cancelled') {
      // Cancel every active booking on the trip (seats released, refunds flagged)
      const [active] = await pool.query("SELECT id FROM bookings WHERE trip_id = ? AND booking_status IN ('pending','reserved','confirmed')", [trip.id]);
      for (const b of active) {
        await cancelBooking(b.id, { type: 'admin', reason: `Trip cancelled${req.body.reason ? ': ' + req.body.reason : ''}` }, req);
        cancelled++;
      }
    }
    await withTransaction(async (conn) => {
      await conn.query('UPDATE trips SET status = ? WHERE id = ?', [next_, trip.id]);
      if (next_ === 'completed') {
        await conn.query("UPDATE bookings SET booking_status = 'completed' WHERE trip_id = ? AND booking_status = 'confirmed'", [trip.id]);
      }
      await audit(req, { action: `trip.status.${next_}`, module: 'trips', recordId: trip.id, oldValues: { status: trip.status }, newValues: { status: next_, bookings_cancelled: cancelled } }, conn);
    });
    return success(res, { cancelled_bookings: cancelled }, cancelled ? `Trip cancelled. ${cancelled} booking(s) cancelled.` : `Trip marked ${next_}`);
  } catch (err) { next(err); }
});

// POST /api/admin/trips/:id/seats/block { seat_ids, blocked }
router.post('/:id/seats/block', requirePermission('trips.manage'), validate([
  param('id').isInt().toInt(),
  body('seat_ids').isArray({ min: 1 }),
  body('blocked').isBoolean(),
]), async (req, res, next) => {
  try {
    const result = await setSeatsBlocked(req.params.id, req.body.seat_ids, req.body.blocked === true || req.body.blocked === 'true');
    await audit(req, { action: result.blocked ? 'trip.seats.block' : 'trip.seats.unblock', module: 'trips', recordId: req.params.id, newValues: { seat_ids: result.seat_ids } });
    return success(res, result, result.blocked ? 'Seats blocked' : 'Seats unblocked');
  } catch (err) { next(err); }
});

module.exports = router;
