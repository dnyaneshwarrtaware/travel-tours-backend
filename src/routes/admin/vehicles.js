const router = require('express').Router();
const { body, param } = require('express-validator');
const validate = require('../../middleware/validate');
const { pool } = require('../../config/database');
const { success, error } = require('../../utils/response');
const { toFlag, updateClause, diff } = require('../../utils/admin');
const { audit } = require('../../services/audit.service');

const VEHICLE_TYPES = ['bus', 'sleeper_bus', 'luxury_bus', 'mini_bus', 'tempo_traveller', 'suv', 'sedan'];
const REG_RE = /^[A-Z]{2}\d{1,2}[A-Z]{0,3}\d{4}$/;

const fields = (partial = false) => {
  const r = (c) => (partial ? c.optional() : c);
  return [
    r(body('registration_number')).trim().customSanitizer(v => String(v).toUpperCase().replace(/[\s-]/g, ''))
      .matches(REG_RE).withMessage('Enter a valid vehicle number, e.g. MH12AB1234'),
    r(body('name')).trim().isLength({ min: 2, max: 150 }).withMessage('Vehicle name is required'),
    r(body('type')).isIn(VEHICLE_TYPES).withMessage('Select a vehicle type'),
    r(body('seat_layout_id')).isInt({ min: 1 }).withMessage('Select a seat layout').toInt(),
    body('operator_id').optional({ values: 'falsy' }).isInt({ min: 1 }).toInt(),
    body('amenities').optional().isArray().withMessage('Amenities must be a list'),
  ];
};

// GET /api/admin/vehicles
router.get('/', async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT v.id, v.name, v.type, v.registration_number, v.capacity, v.is_ac, v.seat_type, v.amenities, v.description,
              v.is_active, v.operator_id, v.seat_layout_id, o.name AS operator_name, sl.name AS seat_layout_name,
              (SELECT COUNT(*) FROM trips t WHERE t.vehicle_id = v.id AND t.travel_date >= CURDATE() AND t.status <> 'cancelled') AS upcoming_trips
       FROM vehicles v
       LEFT JOIN operators o ON o.id = v.operator_id
       LEFT JOIN seat_layouts sl ON sl.id = v.seat_layout_id
       WHERE v.deleted_at IS NULL
       ORDER BY v.is_active DESC, v.seat_layout_id IS NULL, v.name, v.registration_number`
    );
    return success(res, rows);
  } catch (err) { next(err); }
});

const layoutInfo = async (layoutId) => {
  const [rows] = await pool.query(
    `SELECT sl.id, sl.seat_type, sl.is_active,
            (SELECT COUNT(*) FROM seat_layout_seats s WHERE s.seat_layout_id = sl.id AND s.is_active = 1) AS seats
     FROM seat_layouts sl WHERE sl.id = ?`, [layoutId]
  );
  return rows[0] || null;
};

const buildData = async (body, partial) => {
  const data = {};
  ['registration_number', 'name', 'type', 'operator_id', 'description'].forEach(k => {
    if (body[k] !== undefined) data[k] = body[k] === '' ? null : body[k];
  });
  if (body.amenities !== undefined) data.amenities = JSON.stringify(body.amenities.map(String).slice(0, 20));
  if (body.is_ac !== undefined || !partial) data.is_ac = toFlag(body.is_ac);
  if (body.is_active !== undefined) data.is_active = toFlag(body.is_active);
  if (body.seat_layout_id !== undefined) {
    const layout = await layoutInfo(body.seat_layout_id);
    if (!layout || !layout.is_active) throw Object.assign(new Error('Selected seat layout is not available'), { statusCode: 400 });
    data.seat_layout_id = layout.id;
    data.seat_type = layout.seat_type;
    data.capacity = layout.seats;
  }
  return data;
};

router.post('/', validate(fields()), async (req, res, next) => {
  try {
    const data = await buildData(req.body, false);
    if (data.is_active === undefined) data.is_active = 1;
    const [r] = await pool.query('INSERT INTO vehicles SET ?', [data]);
    await audit(req, { action: 'vehicle.create', module: 'vehicles', recordId: r.insertId, newValues: data });
    return success(res, { id: r.insertId }, 'Vehicle created', 201);
  } catch (err) { next(err); }
});

router.put('/:id', validate([param('id').isInt().toInt(), ...fields(true)]), async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT * FROM vehicles WHERE id = ? AND deleted_at IS NULL', [req.params.id]);
    if (!rows.length) return error(res, 'Vehicle not found', 404);
    const v = rows[0];
    const data = await buildData(req.body, true);

    if (data.seat_layout_id !== undefined && data.seat_layout_id !== v.seat_layout_id) {
      const [[{ n }]] = await pool.query(
        `SELECT COUNT(*) AS n FROM trip_seats ts JOIN trips t ON t.id = ts.trip_id
         WHERE t.vehicle_id = ? AND t.travel_date >= CURDATE() AND ts.status IN ('BOOKED','BLOCKED')`, [v.id]
      );
      if (n > 0) return error(res, 'The seat layout cannot be changed while upcoming trips on this vehicle have booked or blocked seats', 400);
    }
    const { oldValues, newValues, changed } = diff(v, data);
    if (!changed) return success(res, null, 'No changes');
    const { sql, values } = updateClause(data);
    await pool.query(`UPDATE vehicles SET ${sql} WHERE id = ?`, [...values, v.id]);
    await audit(req, { action: 'vehicle.update', module: 'vehicles', recordId: v.id, oldValues, newValues });
    return success(res, null, 'Vehicle updated');
  } catch (err) { next(err); }
});

module.exports = router;
