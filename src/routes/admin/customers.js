const router = require('express').Router();
const { param } = require('express-validator');
const validate = require('../../middleware/validate');
const { pool } = require('../../config/database');
const { success, error, paginated, buildPaginationMeta } = require('../../utils/response');
const { pagination } = require('../../utils/admin');

// GET /api/admin/customers?q=&type=registered|guest
router.get('/', async (req, res, next) => {
  try {
    const { page, limit, offset } = pagination(req.query, 25);
    const cond = []; const params = [];
    if (req.query.q) { cond.push('(c.name LIKE ? OR c.email LIKE ? OR c.phone LIKE ?)'); params.push(...Array(3).fill(`%${req.query.q}%`)); }
    if (req.query.type === 'registered') cond.push('c.password_hash IS NOT NULL');
    if (req.query.type === 'guest') cond.push('c.password_hash IS NULL');
    const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
    const [rows] = await pool.query(
      `SELECT c.id, c.name, c.email, c.phone, c.is_active, c.created_at, c.last_login_at,
              (c.password_hash IS NOT NULL) AS is_registered,
              COUNT(b.id) AS booking_count,
              COALESCE(SUM(CASE WHEN b.payment_status = 'paid' THEN b.total_amount END), 0) AS total_paid,
              MAX(b.created_at) AS last_booking_at
       FROM customers c LEFT JOIN bookings b ON b.customer_id = c.id
       ${where} GROUP BY c.id ORDER BY last_booking_at IS NULL, last_booking_at DESC, c.id DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM customers c ${where}`, params);
    return paginated(res, rows, buildPaginationMeta(total, page, limit));
  } catch (err) { next(err); }
});

router.get('/:id', validate([param('id').isInt()]), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      'SELECT id, name, email, phone, is_active, created_at, last_login_at, (password_hash IS NOT NULL) AS is_registered FROM customers WHERE id = ?',
      [req.params.id]
    );
    if (!rows.length) return error(res, 'Customer not found', 404);
    const [bookings] = await pool.query(
      `SELECT b.id, b.booking_number, b.booking_status, b.payment_status, b.payment_method, b.total_amount, b.seat_count, b.created_at,
              t.travel_date, fl.city AS from_city, tl.city AS to_city
       FROM bookings b JOIN trips t ON t.id = b.trip_id JOIN routes r ON r.id = t.route_id
       JOIN locations fl ON fl.id = r.from_location_id JOIN locations tl ON tl.id = r.to_location_id
       WHERE b.customer_id = ? ORDER BY b.created_at DESC`, [req.params.id]
    );
    return success(res, { ...rows[0], bookings });
  } catch (err) { next(err); }
});

module.exports = router;
