const router = require('express').Router();
const { query } = require('express-validator');
const validate = require('../../middleware/validate');
const { pool } = require('../../config/database');
const { success } = require('../../utils/response');
const { isValidDate, todayIST, addMinutesToDateTime } = require('../../utils/time');

const range = validate([
  query('from').optional({ values: 'falsy' }).custom(isValidDate).withMessage('Invalid from date'),
  query('to').optional({ values: 'falsy' }).custom(isValidDate).withMessage('Invalid to date'),
]);
const dates = (q) => ({
  from: q.from || addMinutesToDateTime(todayIST(), '00:00:00', -29 * 1440).slice(0, 10),
  to: q.to || todayIST(),
});

// Bookings created per day, split by status
router.get('/bookings', range, async (req, res, next) => {
  try {
    const { from, to } = dates(req.query);
    const [daily] = await pool.query(
      `SELECT DATE_FORMAT(b.created_at, '%Y-%m-%d') AS date, COUNT(*) AS bookings, SUM(b.seat_count) AS seats,
              SUM(b.booking_status = 'confirmed' OR b.booking_status = 'completed') AS confirmed,
              SUM(b.booking_status IN ('pending','reserved')) AS pending,
              SUM(b.booking_status = 'cancelled') AS cancelled,
              SUM(b.total_amount) AS booked_value
       FROM bookings b WHERE DATE(b.created_at) BETWEEN ? AND ? GROUP BY date ORDER BY date`, [from, to]
    );
    const [byStatus] = await pool.query(
      'SELECT booking_status AS status, COUNT(*) AS count FROM bookings WHERE DATE(created_at) BETWEEN ? AND ? GROUP BY booking_status', [from, to]
    );
    const [bySource] = await pool.query(
      'SELECT source, payment_method, COUNT(*) AS count FROM bookings WHERE DATE(created_at) BETWEEN ? AND ? GROUP BY source, payment_method', [from, to]
    );
    return success(res, { from, to, daily, by_status: byStatus, by_source: bySource });
  } catch (err) { next(err); }
});

// Revenue collected per day (payments marked paid), by method
router.get('/revenue', range, async (req, res, next) => {
  try {
    const { from, to } = dates(req.query);
    const [daily] = await pool.query(
      `SELECT DATE_FORMAT(p.payment_date, '%Y-%m-%d') AS date,
              SUM(CASE WHEN p.payment_method = 'CASH' THEN p.amount ELSE 0 END) AS cash,
              SUM(CASE WHEN p.payment_method = 'UPI_QR' THEN p.amount ELSE 0 END) AS upi_qr,
              SUM(p.amount) AS total, COUNT(*) AS payments
       FROM payments p WHERE p.payment_status = 'paid' AND DATE(p.payment_date) BETWEEN ? AND ?
       GROUP BY date ORDER BY date`, [from, to]
    );
    const [[outstanding]] = await pool.query(
      `SELECT COALESCE(SUM(CASE WHEN payment_status = 'pending' THEN amount END), 0) AS cash_pending,
              COALESCE(SUM(CASE WHEN payment_status = 'verification_pending' THEN amount END), 0) AS verification_pending,
              COALESCE(SUM(CASE WHEN payment_status = 'refund_pending' THEN amount END), 0) AS refund_pending,
              COALESCE(SUM(CASE WHEN payment_status = 'refunded' THEN amount END), 0) AS refunded
       FROM payments`
    );
    return success(res, { from, to, daily, outstanding });
  } catch (err) { next(err); }
});

// Per-route performance for trips in range (by travel date)
router.get('/routes', range, async (req, res, next) => {
  try {
    const { from, to } = dates(req.query);
    const [rows] = await pool.query(
      `SELECT r.id, COALESCE(r.name, CONCAT(fl.city, ' → ', tl.city)) AS route, fl.city AS from_city, tl.city AS to_city,
              COUNT(DISTINCT t.id) AS trips,
              COUNT(DISTINCT CASE WHEN b.booking_status <> 'cancelled' THEN b.id END) AS bookings,
              COALESCE(SUM(CASE WHEN b.booking_status <> 'cancelled' THEN b.seat_count END), 0) AS seats_sold,
              COALESCE(SUM(CASE WHEN b.payment_status = 'paid' THEN b.total_amount END), 0) AS revenue,
              COUNT(DISTINCT CASE WHEN b.booking_status = 'cancelled' THEN b.id END) AS cancellations
       FROM routes r
       JOIN locations fl ON fl.id = r.from_location_id JOIN locations tl ON tl.id = r.to_location_id
       LEFT JOIN trips t ON t.route_id = r.id AND t.travel_date BETWEEN ? AND ? AND t.status <> 'cancelled'
       LEFT JOIN bookings b ON b.trip_id = t.id
       WHERE r.deleted_at IS NULL
       GROUP BY r.id ORDER BY revenue DESC, bookings DESC`, [from, to]
    );
    return success(res, { from, to, rows });
  } catch (err) { next(err); }
});

// Per-vehicle utilisation for trips in range
router.get('/vehicles', range, async (req, res, next) => {
  try {
    const { from, to } = dates(req.query);
    const [rows] = await pool.query(
      `SELECT v.id, v.name, v.registration_number, v.capacity,
              COUNT(DISTINCT t.id) AS trips,
              COALESCE(SUM(CASE WHEN b.booking_status <> 'cancelled' THEN b.seat_count END), 0) AS seats_sold,
              COALESCE(SUM(CASE WHEN b.payment_status = 'paid' THEN b.total_amount END), 0) AS revenue
       FROM vehicles v
       LEFT JOIN trips t ON t.vehicle_id = v.id AND t.travel_date BETWEEN ? AND ? AND t.status <> 'cancelled'
       LEFT JOIN bookings b ON b.trip_id = t.id
       WHERE v.deleted_at IS NULL
       GROUP BY v.id ORDER BY revenue DESC`, [from, to]
    );
    rows.forEach(r => {
      const capacity = r.trips * r.capacity;
      r.occupancy_pct = capacity ? Math.round((r.seats_sold / capacity) * 1000) / 10 : 0;
    });
    return success(res, { from, to, rows });
  } catch (err) { next(err); }
});

module.exports = router;
