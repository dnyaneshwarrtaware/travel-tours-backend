const { pool } = require('../config/database');
const { success } = require('../utils/response');

// GET /api/admin/dashboard - booking, payment and fleet stats
const getDashboardStats = async (req, res, next) => {
  try {
    const [[stats]] = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM bookings WHERE DATE(created_at) = CURDATE()) AS today_bookings,
        (SELECT COALESCE(SUM(seat_count),0) FROM bookings WHERE DATE(created_at) = CURDATE() AND booking_status <> 'cancelled') AS today_seats,
        (SELECT COALESCE(SUM(amount),0) FROM payments WHERE payment_status = 'paid' AND DATE(payment_date) = CURDATE()) AS today_revenue,
        (SELECT COUNT(*) FROM routes WHERE is_active = 1 AND deleted_at IS NULL) AS active_routes,
        (SELECT COUNT(*) FROM vehicles WHERE is_active = 1 AND deleted_at IS NULL) AS active_vehicles,
        (SELECT COUNT(*) FROM payments p JOIN bookings b ON b.id = p.booking_id
           WHERE p.payment_status IN ('pending','verification_pending') AND b.booking_status NOT IN ('cancelled','no_show')) AS pending_payments,
        (SELECT COUNT(*) FROM payments WHERE payment_status = 'verification_pending') AS verification_pending,
        (SELECT COUNT(*) FROM payments WHERE payment_status = 'refund_pending') AS refund_pending,
        (SELECT COUNT(*) FROM trips WHERE status IN ('scheduled','boarding')
           AND (travel_date > CURDATE() OR (travel_date = CURDATE() AND departure_time >= CURTIME()))) AS upcoming_trips,
        (SELECT COUNT(*) FROM trips WHERE travel_date = CURDATE() AND status <> 'cancelled') AS today_trips,
        (SELECT COALESCE(SUM(amount),0) FROM payments WHERE payment_status = 'paid' AND payment_date >= DATE_FORMAT(CURDATE(), '%Y-%m-01')) AS month_revenue,
        (SELECT COUNT(*) FROM enquiries WHERE status = 'new') AS new_enquiries
    `);

    // Last 14 days: bookings created + revenue collected
    const [trend] = await pool.query(`
      WITH RECURSIVE days AS (
        SELECT CURDATE() - INTERVAL 13 DAY AS d UNION ALL SELECT d + INTERVAL 1 DAY FROM days WHERE d < CURDATE()
      )
      SELECT DATE_FORMAT(days.d, '%Y-%m-%d') AS date,
             (SELECT COUNT(*) FROM bookings b WHERE DATE(b.created_at) = days.d) AS bookings,
             (SELECT COALESCE(SUM(p.amount),0) FROM payments p WHERE p.payment_status = 'paid' AND DATE(p.payment_date) = days.d) AS revenue
      FROM days ORDER BY days.d
    `);

    const [routeStats] = await pool.query(`
      SELECT COALESCE(r.name, CONCAT(fl.city, ' → ', tl.city)) AS route,
             COUNT(b.id) AS bookings, COALESCE(SUM(CASE WHEN b.payment_status = 'paid' THEN b.total_amount END), 0) AS revenue
      FROM routes r
      JOIN locations fl ON fl.id = r.from_location_id JOIN locations tl ON tl.id = r.to_location_id
      LEFT JOIN trips t ON t.route_id = r.id
      LEFT JOIN bookings b ON b.trip_id = t.id AND b.booking_status <> 'cancelled' AND b.created_at >= CURDATE() - INTERVAL 30 DAY
      WHERE r.deleted_at IS NULL AND r.is_active = 1
      GROUP BY r.id ORDER BY bookings DESC LIMIT 6
    `);

    const [paymentStatus] = await pool.query(`
      SELECT payment_status AS status, COUNT(*) AS count FROM bookings
      WHERE created_at >= CURDATE() - INTERVAL 30 DAY GROUP BY payment_status
    `);

    const [pendingPayments] = await pool.query(`
      SELECT p.id, p.payment_method, p.payment_status, p.amount, p.created_at, b.booking_number, b.contact_name
      FROM payments p JOIN bookings b ON b.id = p.booking_id
      WHERE p.payment_status IN ('verification_pending','pending') AND b.booking_status NOT IN ('cancelled','no_show')
      ORDER BY FIELD(p.payment_status, 'verification_pending', 'pending'), p.created_at DESC LIMIT 6
    `);

    const [recentBookings] = await pool.query(`
      SELECT b.id, b.booking_number, b.contact_name, b.total_amount, b.seat_count, b.booking_status, b.payment_status, b.payment_method,
             b.created_at, fl.city AS from_city, tl.city AS to_city, t.travel_date
      FROM bookings b JOIN trips t ON t.id = b.trip_id JOIN routes r ON r.id = t.route_id
      JOIN locations fl ON fl.id = r.from_location_id JOIN locations tl ON tl.id = r.to_location_id
      ORDER BY b.created_at DESC, b.id DESC LIMIT 8
    `);

    const [upcomingTrips] = await pool.query(`
      SELECT t.id, t.travel_date, t.departure_time, t.status, fl.city AS from_city, tl.city AS to_city, v.name AS vehicle_name, v.registration_number,
             (SELECT COALESCE(SUM(b.seat_count),0) FROM bookings b WHERE b.trip_id = t.id AND b.booking_status IN ('pending','reserved','confirmed')) AS seats_booked,
             v.capacity
      FROM trips t JOIN routes r ON r.id = t.route_id
      JOIN locations fl ON fl.id = r.from_location_id JOIN locations tl ON tl.id = r.to_location_id
      JOIN vehicles v ON v.id = t.vehicle_id
      WHERE t.status IN ('scheduled','boarding') AND (t.travel_date > CURDATE() OR (t.travel_date = CURDATE() AND t.departure_time >= CURTIME()))
      ORDER BY t.travel_date, t.departure_time LIMIT 6
    `);

    return success(res, {
      stats,
      trend,
      route_stats: routeStats,
      payment_status: paymentStatus,
      pending_payments: pendingPayments,
      recent_bookings: recentBookings,
      upcoming_trips: upcomingTrips,
    });
  } catch (err) {
    next(err);
  }
};

module.exports = { getDashboardStats };
