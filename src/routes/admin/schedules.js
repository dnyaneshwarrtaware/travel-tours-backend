const router = require('express').Router();
const { body, param } = require('express-validator');
const validate = require('../../middleware/validate');
const { pool, withTransaction } = require('../../config/database');
const { success, error } = require('../../utils/response');
const { toFlag, diff, updateClause } = require('../../utils/admin');
const { isValidDate, isValidTime, normalizeTime, todayIST } = require('../../utils/time');
const { audit } = require('../../services/audit.service');
const { generateTripsForSchedule } = require('../../services/tripAdmin.service');

const DAYS_RE = /^[0-6](,[0-6]){0,6}$/;

const fields = (partial = false) => {
  const r = (c) => (partial ? c.optional() : c);
  return [
    r(body('route_id')).isInt({ min: 1 }).withMessage('Select a route').toInt(),
    r(body('vehicle_id')).isInt({ min: 1 }).withMessage('Select a vehicle').toInt(),
    r(body('departure_time')).custom(isValidTime).withMessage('Enter a valid departure time').customSanitizer(normalizeTime),
    body('arrival_time').optional({ values: 'falsy' }).custom(isValidTime).withMessage('Enter a valid arrival time').customSanitizer(normalizeTime),
    r(body('days_of_week')).matches(DAYS_RE).withMessage('Select at least one day'),
    r(body('start_date')).custom(isValidDate).withMessage('Select a start date'),
    r(body('end_date')).custom(isValidDate).withMessage('Select an end date')
      .custom((v, { req }) => !req.body.start_date || v >= req.body.start_date).withMessage('End date must be after start date'),
    body('fare_adjustment_pct').optional({ values: 'falsy' }).isFloat({ min: -90, max: 300 }),
  ];
};

router.get('/', async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT s.*, fl.city AS from_city, tl.city AS to_city, r.name AS route_name, v.name AS vehicle_name, v.registration_number,
              (SELECT COUNT(*) FROM trips t WHERE t.schedule_id = s.id AND t.travel_date >= CURDATE()) AS upcoming_trips,
              (SELECT MAX(t.travel_date) FROM trips t WHERE t.schedule_id = s.id) AS last_trip_date
       FROM schedules s JOIN routes r ON r.id = s.route_id
       JOIN locations fl ON fl.id = r.from_location_id JOIN locations tl ON tl.id = r.to_location_id
       JOIN vehicles v ON v.id = s.vehicle_id
       ORDER BY s.is_active DESC, fl.city, tl.city, s.departure_time`
    );
    return success(res, rows);
  } catch (err) { next(err); }
});

const pickData = (b) => {
  const data = {};
  ['route_id', 'vehicle_id', 'departure_time', 'arrival_time', 'days_of_week', 'start_date', 'end_date', 'fare_adjustment_pct'].forEach(k => {
    if (b[k] !== undefined) data[k] = b[k] === '' ? null : b[k];
  });
  if (data.fare_adjustment_pct === null) data.fare_adjustment_pct = 0;
  if (b.is_active !== undefined) data.is_active = toFlag(b.is_active);
  return data;
};

router.post('/', validate(fields()), async (req, res, next) => {
  try {
    const data = { ...pickData(req.body), created_by: req.user.id };
    const [r] = await pool.query('INSERT INTO schedules SET ?', [data]);
    await audit(req, { action: 'schedule.create', module: 'schedules', recordId: r.insertId, newValues: data });
    return success(res, { id: r.insertId }, 'Schedule created. Use "Generate trips" to publish trips.', 201);
  } catch (err) { next(err); }
});

router.put('/:id', validate([param('id').isInt(), ...fields(true)]), async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT * FROM schedules WHERE id = ?', [req.params.id]);
    if (!rows.length) return error(res, 'Schedule not found', 404);
    const data = pickData(req.body);
    const { oldValues, newValues, changed } = diff(rows[0], data);
    if (!changed) return success(res, null, 'No changes');
    const { sql, values } = updateClause(data);
    await pool.query(`UPDATE schedules SET ${sql} WHERE id = ?`, [...values, req.params.id]);
    await audit(req, { action: 'schedule.update', module: 'schedules', recordId: Number(req.params.id), oldValues, newValues });
    return success(res, null, 'Schedule updated. Already generated trips are not changed.');
  } catch (err) { next(err); }
});

// POST /api/admin/schedules/:id/generate { from_date, to_date }
router.post('/:id/generate', validate([
  param('id').isInt(),
  body('from_date').custom(isValidDate).withMessage('Select a from date'),
  body('to_date').custom(isValidDate).withMessage('Select a to date')
    .custom((v, { req }) => v >= req.body.from_date).withMessage('To date must be after from date'),
]), async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT * FROM schedules WHERE id = ?', [req.params.id]);
    if (!rows.length) return error(res, 'Schedule not found', 404);
    const schedule = rows[0];
    if (!schedule.is_active) return error(res, 'Activate the schedule before generating trips', 400);
    const from = req.body.from_date < todayIST() ? todayIST() : req.body.from_date;
    const days = (Date.parse(req.body.to_date) - Date.parse(from)) / 86400000;
    if (days > 120) return error(res, 'Generate at most 120 days at a time', 400);

    const result = await withTransaction(async (conn) => {
      const out = await generateTripsForSchedule(conn, schedule, from, req.body.to_date, req.user.id);
      await audit(req, { action: 'schedule.generate', module: 'schedules', recordId: schedule.id, newValues: { from, to: req.body.to_date, created: out.created, skipped: out.skipped.length } }, conn);
      return out;
    });
    return success(res, result, `${result.created} trip(s) created${result.skipped.length ? `, ${result.skipped.length} skipped` : ''}`);
  } catch (err) { next(err); }
});

module.exports = router;
