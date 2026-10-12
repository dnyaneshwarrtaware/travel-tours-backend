const router = require('express').Router();
const { body, param } = require('express-validator');
const validate = require('../../middleware/validate');
const { requirePermission } = require('../../middleware/auth');
const { pool } = require('../../config/database');
const { success, error, buildPaginationMeta } = require('../../utils/response');
const { pagination } = require('../../utils/admin');
const { applyPaymentAction } = require('../../services/payments/payment.service');

const PAYMENT_STATUSES = ['pending', 'verification_pending', 'paid', 'failed', 'refund_pending', 'refunded', 'not_applicable'];

const SELECT = `
  SELECT p.*, b.booking_number, b.contact_name, b.contact_phone, b.booking_status, b.total_amount AS booking_amount,
         b.seat_count, t.travel_date, t.departure_time, fl.city AS from_city, tl.city AS to_city, u.name AS verified_by_name
  FROM payments p
  JOIN bookings b ON b.id = p.booking_id
  JOIN trips t ON t.id = b.trip_id JOIN routes r ON r.id = t.route_id
  JOIN locations fl ON fl.id = r.from_location_id JOIN locations tl ON tl.id = r.to_location_id
  LEFT JOIN users u ON u.id = p.verified_by`;

// GET /api/admin/payments?status=&method=&q=
router.get('/', async (req, res, next) => {
  try {
    const { page, limit, offset } = pagination(req.query, 25);
    const cond = []; const params = [];
    if (PAYMENT_STATUSES.includes(req.query.status)) { cond.push('p.payment_status = ?'); params.push(req.query.status); }
    if (req.query.status === 'action_needed') cond.push("p.payment_status IN ('pending','verification_pending','refund_pending') AND b.booking_status <> 'no_show'");
    if (['CASH', 'UPI_QR'].includes(req.query.method)) { cond.push('p.payment_method = ?'); params.push(req.query.method); }
    if (req.query.q) {
      cond.push('(b.booking_number LIKE ? OR b.contact_name LIKE ? OR b.contact_phone LIKE ? OR p.upi_reference LIKE ? OR p.transaction_reference LIKE ?)');
      params.push(...Array(5).fill(`%${req.query.q}%`));
    }
    const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
    const [rows] = await pool.query(
      `${SELECT} ${where}
       ORDER BY FIELD(p.payment_status, 'verification_pending', 'pending', 'refund_pending') DESC, p.created_at DESC, p.id DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) AS total FROM payments p JOIN bookings b ON b.id = p.booking_id ${where}`, params
    );
    const [summary] = await pool.query('SELECT payment_status, COUNT(*) AS count, SUM(amount) AS amount FROM payments GROUP BY payment_status');
    return res.json({ success: true, message: 'Request successful', data: rows, meta: { ...buildPaginationMeta(total, page, limit), summary } });
  } catch (err) { next(err); }
});

router.get('/:id', validate([param('id').isInt()]), async (req, res, next) => {
  try {
    const [rows] = await pool.query(`${SELECT} WHERE p.id = ?`, [req.params.id]);
    if (!rows.length) return error(res, 'Payment not found', 404);
    return success(res, rows[0]);
  } catch (err) { next(err); }
});

const actionInput = [
  param('id').isInt().toInt(),
  body('transaction_reference').optional({ nullable: true }).isString().trim().isLength({ max: 100 }).withMessage('Reference is too long'),
  body('remarks').optional({ nullable: true }).isString().trim().isLength({ max: 1000 }).withMessage('Remarks are too long'),
  body('amount').optional({ values: 'falsy' }).isFloat({ min: 0 }).withMessage('Invalid amount'),
];

const action = (name, message) => [
  requirePermission('payments.verify'),
  validate(actionInput),
  async (req, res, next) => {
    try {
      const result = await applyPaymentAction(req.params.id, name, req.body, req);
      return success(res, result, message);
    } catch (err) { next(err); }
  },
];

router.post('/:id/verify', ...action('verify', 'Payment verified. Booking confirmed.'));
router.post('/:id/mark-paid', ...action('mark_paid', 'Payment marked as paid. Booking confirmed.'));
router.post('/:id/reject', ...action('reject', 'Payment rejected'));
router.post('/:id/refund', ...action('refund', 'Payment marked as refunded'));
router.put('/:id', ...action('update', 'Payment details updated'));

module.exports = router;
