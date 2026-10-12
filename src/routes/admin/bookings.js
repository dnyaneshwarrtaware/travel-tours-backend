const router = require('express').Router();
const { body, param } = require('express-validator');
const validate = require('../../middleware/validate');
const { requirePermission, hasPermission } = require('../../middleware/auth');
const { pool } = require('../../config/database');
const { success, paginated, buildPaginationMeta } = require('../../utils/response');
const { pagination } = require('../../utils/admin');
const bookingService = require('../../services/booking.service');

const BOOKING_STATUSES = ['pending', 'reserved', 'confirmed', 'cancelled', 'completed', 'no_show'];
const PAYMENT_STATUSES = ['pending', 'verification_pending', 'paid', 'failed', 'refund_pending', 'refunded', 'not_applicable'];

// GET /api/admin/bookings
router.get('/', async (req, res, next) => {
  try {
    const { page, limit, offset } = pagination(req.query, 25);
    const { q, booking_status, payment_status, payment_method, route_id, trip_id, date_from, date_to, created_from, created_to, customer_id } = req.query;
    const cond = []; const params = [];
    if (q) {
      cond.push('(b.booking_number LIKE ? OR b.contact_name LIKE ? OR b.contact_phone LIKE ?)');
      params.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }
    if (BOOKING_STATUSES.includes(booking_status)) { cond.push('b.booking_status = ?'); params.push(booking_status); }
    if (PAYMENT_STATUSES.includes(payment_status)) { cond.push('b.payment_status = ?'); params.push(payment_status); }
    if (['CASH', 'UPI_QR'].includes(payment_method)) { cond.push('b.payment_method = ?'); params.push(payment_method); }
    if (route_id) { cond.push('t.route_id = ?'); params.push(route_id); }
    if (trip_id) { cond.push('b.trip_id = ?'); params.push(trip_id); }
    if (customer_id) { cond.push('b.customer_id = ?'); params.push(customer_id); }
    if (date_from) { cond.push('t.travel_date >= ?'); params.push(date_from); }
    if (date_to) { cond.push('t.travel_date <= ?'); params.push(date_to); }
    if (created_from) { cond.push('b.created_at >= ?'); params.push(`${created_from} 00:00:00`); }
    if (created_to) { cond.push('b.created_at <= ?'); params.push(`${created_to} 23:59:59`); }
    const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
    const from = `FROM bookings b JOIN trips t ON t.id = b.trip_id JOIN routes r ON r.id = t.route_id
                  JOIN locations fl ON fl.id = r.from_location_id JOIN locations tl ON tl.id = r.to_location_id
                  JOIN route_stops bs ON bs.id = b.boarding_stop_id JOIN route_stops ds ON ds.id = b.dropping_stop_id`;

    const [rows] = await pool.query(
      `SELECT b.id, b.booking_number, b.contact_name, b.contact_phone, b.seat_count, b.total_amount, b.payment_method,
              b.booking_status, b.payment_status, b.source, b.created_at, b.cancelled_at, b.cancellation_reason,
              t.travel_date, t.departure_time, fl.city AS from_city, tl.city AS to_city,
              bs.stop_name AS boarding_stop_name, ds.stop_name AS dropping_stop_name,
              (SELECT GROUP_CONCAT(s.seat_number ORDER BY s.row_no, s.col_no SEPARATOR ', ')
                 FROM booking_passengers bp JOIN seat_layout_seats s ON s.id = bp.seat_id WHERE bp.booking_id = b.id) AS seats,
              (SELECT p.id FROM payments p WHERE p.booking_id = b.id ORDER BY p.id DESC LIMIT 1) AS payment_id
       ${from} ${where} ORDER BY b.created_at DESC, b.id DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total ${from} ${where}`, params);
    return paginated(res, rows, buildPaginationMeta(total, page, limit));
  } catch (err) { next(err); }
});

router.get('/:id', validate([param('id').isInt().toInt()]), async (req, res, next) => {
  try { return success(res, await bookingService.getBookingDetail({ id: req.params.id })); } catch (err) { next(err); }
});

// POST /api/admin/bookings - counter booking by admin
router.post('/', requirePermission('bookings.manage'), validate([
  body('trip_id').isInt({ min: 1 }).withMessage('Select a trip').toInt(),
  body('boarding_stop_id').isInt({ min: 1 }).withMessage('Select a boarding point').toInt(),
  body('dropping_stop_id').isInt({ min: 1 }).withMessage('Select a dropping point').toInt(),
  body('passengers').isArray({ min: 1 }).withMessage('Add passenger details'),
  body('contact').isObject().withMessage('Add contact details'),
  body('payment_method').isIn(['CASH', 'UPI_QR']).withMessage('Select a payment method'),
  body('mark_paid_now').optional().isBoolean(),
]), async (req, res, next) => {
  try {
    // Recording a payment needs payment permission too
    if (req.body.mark_paid_now && !hasPermission(req.adminUser, 'payments.verify')) {
      return res.status(403).json({ success: false, message: 'You do not have permission to record payments' });
    }
    const booking = await bookingService.createBooking(req.body, { req, source: 'admin', adminId: req.user.id });
    return success(res, booking, `Booking ${booking.booking_number} created`, 201);
  } catch (err) { next(err); }
});

// POST /api/admin/bookings/:id/cancel { reason }
router.post('/:id/cancel', requirePermission('bookings.manage'), validate([
  param('id').isInt().toInt(),
  body('reason').trim().isLength({ min: 3, max: 500 }).withMessage('Please enter a cancellation reason'),
]), async (req, res, next) => {
  try {
    const booking = await bookingService.cancelBooking(req.params.id, { type: 'admin', reason: req.body.reason }, req);
    return success(res, booking, 'Booking cancelled and seats released');
  } catch (err) { next(err); }
});

// PATCH /api/admin/bookings/:id/status { status: completed | no_show }
router.patch('/:id/status', requirePermission('bookings.manage'), validate([
  param('id').isInt().toInt(),
  body('status').isIn(['completed', 'no_show']).withMessage('Invalid status'),
]), async (req, res, next) => {
  try {
    const booking = await bookingService.updateBookingStatus(req.params.id, req.body.status, req);
    return success(res, booking, 'Booking updated');
  } catch (err) { next(err); }
});

module.exports = router;
