const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const { body, query, param } = require('express-validator');
const validate = require('../middleware/validate');
const { optionalAuth, verifyCustomer } = require('../middleware/auth');
const { pool } = require('../config/database');
const { success, error } = require('../utils/response');
const bookingService = require('../services/booking.service');

// Booking lookups are keyed by booking number + phone; limit guessing.
const lookupLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 40, standardHeaders: true, legacyHeaders: false,
  message: { success: false, message: 'Too many attempts. Please try again later.' },
});

const bookingNumber = param('bookingNumber').matches(/^GT\d{6,12}$/).withMessage('Invalid booking number');

// POST /api/bookings - create a booking (guest or logged-in customer)
router.post('/', optionalAuth, validate([
  body('trip_id').isInt({ min: 1 }).withMessage('Select a trip').toInt(),
  body('boarding_stop_id').isInt({ min: 1 }).withMessage('Select a boarding point').toInt(),
  body('dropping_stop_id').isInt({ min: 1 }).withMessage('Select a dropping point').toInt(),
  body('passengers').isArray({ min: 1 }).withMessage('Add passenger details'),
  body('contact').isObject().withMessage('Add contact details'),
  body('payment_method').isIn(['CASH', 'UPI_QR']).withMessage('Select a payment method'),
  body('lock_token').optional({ nullable: true }).isUUID().withMessage('Invalid seat hold'),
  body('upi_reference').optional({ nullable: true }).isString().isLength({ max: 100 }),
]), async (req, res, next) => {
  try {
    // Customers can only create website bookings; admin-only fields are ignored here
    const { mark_paid_now, transaction_reference, remarks, ...input } = req.body;
    const customerId = req.user?.type === 'customer' ? req.user.id : null;
    const booking = await bookingService.createBooking(input, { req, source: 'website', customerId });
    const msg = booking.payment_status === 'verification_pending'
      ? 'Booking created. Payment verification is pending.'
      : 'Booking created successfully.';
    return success(res, bookingService.publicBooking(booking), msg, 201);
  } catch (err) { next(err); }
});

// GET /api/bookings/lookup?booking_number=&phone=
router.get('/lookup', lookupLimiter, validate([
  query('booking_number').trim().toUpperCase().matches(/^GT\d{6,12}$/).withMessage('Enter a valid booking ID (e.g. GT2026100001)'),
  query('phone').trim().notEmpty().withMessage('Enter the mobile number used for booking'),
]), async (req, res, next) => {
  try {
    const b = await bookingService.getBookingDetail({ booking_number: req.query.booking_number }).catch(() => null);
    if (!b || b.contact_phone !== bookingService.cleanPhone(req.query.phone)) {
      return error(res, 'No booking found with this booking ID and mobile number', 404);
    }
    return success(res, bookingService.publicBooking(b));
  } catch (err) { next(err); }
});

// GET /api/bookings/my - logged-in customer's bookings
router.get('/my', verifyCustomer, async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT b.booking_number, b.booking_status, b.payment_status, b.payment_method, b.total_amount, b.seat_count, b.created_at,
              t.travel_date, t.departure_time, fl.city AS from_city, tl.city AS to_city,
              bs.stop_name AS boarding_stop_name, ds.stop_name AS dropping_stop_name
       FROM bookings b
       JOIN trips t ON t.id = b.trip_id JOIN routes r ON r.id = t.route_id
       JOIN locations fl ON fl.id = r.from_location_id JOIN locations tl ON tl.id = r.to_location_id
       JOIN route_stops bs ON bs.id = b.boarding_stop_id JOIN route_stops ds ON ds.id = b.dropping_stop_id
       WHERE b.customer_id = ? ORDER BY t.travel_date DESC, t.departure_time DESC LIMIT 100`,
      [req.user.id]
    );
    return success(res, rows);
  } catch (err) { next(err); }
});

// GET /api/bookings/my/:bookingNumber
router.get('/my/:bookingNumber', verifyCustomer, validate([bookingNumber]), async (req, res, next) => {
  try {
    const b = await bookingService.getBookingDetail({ booking_number: req.params.bookingNumber });
    if (b.customer_id !== req.user.id) return error(res, 'Booking not found', 404);
    return success(res, bookingService.publicBooking(b));
  } catch (err) { next(err); }
});

// POST /api/bookings/:bookingNumber/cancel { phone, reason } - owner (token) or booking phone
router.post('/:bookingNumber/cancel', lookupLimiter, optionalAuth, validate([
  bookingNumber,
  body('reason').optional({ nullable: true }).isString().isLength({ max: 500 }),
]), async (req, res, next) => {
  try {
    const b = await bookingService.getBookingDetail({ booking_number: req.params.bookingNumber }).catch(() => null);
    const isOwner = b && req.user?.type === 'customer' && b.customer_id === req.user.id;
    const phoneMatches = b && req.body.phone && b.contact_phone === bookingService.cleanPhone(req.body.phone);
    if (!b || (!isOwner && !phoneMatches)) return error(res, 'No booking found with these details', 404);
    const updated = await bookingService.cancelBooking(b.id, { type: 'customer', reason: req.body.reason || 'Cancelled by customer' }, req);
    return success(res, bookingService.publicBooking(updated), 'Booking cancelled');
  } catch (err) { next(err); }
});

module.exports = router;
