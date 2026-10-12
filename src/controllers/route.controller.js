const { pool } = require('../config/database');
const { success, error, paginated, buildPaginationMeta } = require('../utils/response');
const { getRouteStops } = require('../services/trip.service');

// GET /api/routes - public list with filters
const getRoutes = async (req, res, next) => {
  try {
    const { page = 1, limit = 12, popular, search } = req.query;
    const offset = (page - 1) * limit;
    const conditions = ['r.is_active = 1', 'r.deleted_at IS NULL'];
    const params = [];

    if (popular === 'true') { conditions.push('r.is_popular = 1'); }
    if (search) {
      conditions.push('(fl.city LIKE ? OR tl.city LIKE ?)');
      params.push(`%${search}%`, `%${search}%`);
    }

    const where = conditions.join(' AND ');

    const [rows] = await pool.query(
      `SELECT r.id, r.name, r.slug, r.distance_km, r.duration_minutes, r.is_popular, r.from_location_id, r.to_location_id,
              fl.name as from_name, fl.city as from_city, fl.slug as from_slug,
              tl.name as to_name, tl.city as to_city, tl.slug as to_slug,
              r.image,
              (SELECT MIN(rv.custom_price) FROM route_vehicles rv WHERE rv.route_id = r.id AND rv.is_active = 1) as min_price,
              (SELECT f.fare FROM route_fares f
                 JOIN route_stops a ON a.id = f.from_stop_id JOIN route_stops b ON b.id = f.to_stop_id
                 WHERE f.route_id = r.id AND f.is_active = 1 AND a.location_id = r.from_location_id AND b.location_id = r.to_location_id
                 LIMIT 1) as full_fare,
              (SELECT GROUP_CONCAT(rs.stop_name ORDER BY rs.stop_order SEPARATOR ' • ') FROM route_stops rs
                 WHERE rs.route_id = r.id AND rs.is_active = 1) as stop_names,
              (SELECT COUNT(*) FROM trips t WHERE t.route_id = r.id AND t.status IN ('scheduled','boarding')
                 AND t.travel_date BETWEEN CURDATE() AND CURDATE() + INTERVAL 7 DAY) as trips_this_week
       FROM routes r
       JOIN locations fl ON fl.id = r.from_location_id
       JOIN locations tl ON tl.id = r.to_location_id
       WHERE ${where}
       ORDER BY r.is_popular DESC, r.sort_order ASC, r.id DESC
       LIMIT ? OFFSET ?`,
      [...params, parseInt(limit), offset]
    );

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) as total FROM routes r
       JOIN locations fl ON fl.id = r.from_location_id
       JOIN locations tl ON tl.id = r.to_location_id
       WHERE ${where}`,
      params
    );

    return paginated(res, rows, buildPaginationMeta(total, page, limit));
  } catch (err) {
    next(err);
  }
};

// GET /api/routes/:slug - route detail with vehicles and stops
const getRouteBySlug = async (req, res, next) => {
  try {
    const { slug } = req.params;
    const [routes] = await pool.query(
      `SELECT r.*,
              fl.name as from_name, fl.city as from_city, fl.slug as from_slug, fl.latitude as from_lat, fl.longitude as from_lng,
              tl.name as to_name, tl.city as to_city, tl.slug as to_slug, tl.latitude as to_lat, tl.longitude as to_lng
       FROM routes r
       JOIN locations fl ON fl.id = r.from_location_id
       JOIN locations tl ON tl.id = r.to_location_id
       WHERE r.slug = ? AND r.is_active = 1 AND r.deleted_at IS NULL`,
      [slug]
    );
    if (!routes.length) return error(res, 'Route not found', 404);

    const route = routes[0];

    // Vehicles for this route
    const [vehicles] = await pool.query(
      `SELECT v.id, v.name, v.type, v.capacity, v.amenities, v.is_ac,
              rv.custom_price as price
       FROM route_vehicles rv
       JOIN vehicles v ON v.id = rv.vehicle_id
       WHERE rv.route_id = ? AND rv.is_active = 1 AND v.is_active = 1
       ORDER BY rv.custom_price ASC`,
      [route.id]
    );

    // Pickup stops
    const [pickups] = await pool.query(
      'SELECT * FROM route_stops WHERE route_id = ? AND stop_type IN ("pickup","both") AND is_active = 1 ORDER BY stop_order ASC',
      [route.id]
    );

    // Drop stops
    const [drops] = await pool.query(
      'SELECT * FROM route_stops WHERE route_id = ? AND stop_type IN ("drop","both") AND is_active = 1 ORDER BY stop_order ASC',
      [route.id]
    );

    // Active offers for this route
    const [offers] = await pool.query(
      `SELECT id, name, code, offer_type, discount_type, discount_value, maximum_discount, end_date, banner_text
       FROM offers
       WHERE is_active = 1 AND start_date <= CURDATE() AND end_date >= CURDATE()
       AND (route_id = ? OR route_id IS NULL OR applicable_to = 'both')
       LIMIT 3`,
      [route.id]
    );

    // Related routes (same from_location)
    const [related] = await pool.query(
      `SELECT r.slug, fl.city as from_city, tl.city as to_city,
              (SELECT MIN(rv2.custom_price) FROM route_vehicles rv2 WHERE rv2.route_id = r.id AND rv2.is_active = 1) as min_price
       FROM routes r
       JOIN locations fl ON fl.id = r.from_location_id
       JOIN locations tl ON tl.id = r.to_location_id
       WHERE r.from_location_id = ? AND r.id != ? AND r.is_active = 1 AND r.deleted_at IS NULL
       LIMIT 4`,
      [route.from_location_id, route.id]
    );

    // SEO data
    const [seoRows] = await pool.query(
      'SELECT * FROM seo_metadata WHERE page_type = "route" AND page_id = ?',
      [route.id]
    );

    // Ordered stops with reference times, segment fares and the next scheduled trips
    const stops = await getRouteStops(route.id);
    const [fares] = await pool.query(
      'SELECT from_stop_id, to_stop_id, fare FROM route_fares WHERE route_id = ? AND is_active = 1', [route.id]
    );
    const [upcoming] = await pool.query(
      `SELECT t.id, t.travel_date, t.departure_time, t.arrival_time, t.fare_adjustment_pct, v.name AS vehicle_name, v.is_ac, v.seat_type
       FROM trips t JOIN vehicles v ON v.id = t.vehicle_id
       WHERE t.route_id = ? AND t.status IN ('scheduled','boarding') AND v.is_active = 1
         AND (t.travel_date > CURDATE() OR (t.travel_date = CURDATE() AND t.departure_time > CURTIME()))
       ORDER BY t.travel_date, t.departure_time LIMIT 8`,
      [route.id]
    );

    return success(res, {
      ...route,
      vehicles,
      pickup_stops: pickups,
      drop_stops: drops,
      stops: stops.map(s => ({
        id: s.id, stop_name: s.stop_name, location_id: s.location_id, location_city: s.location_city, stop_order: s.stop_order,
        arrival_time: s.arrival_time, departure_time: s.departure_time,
        boarding_allowed: !!s.boarding_allowed, dropping_allowed: !!s.dropping_allowed,
      })),
      fares,
      upcoming_trips: upcoming,
      offers,
      related_routes: related,
      seo: seoRows[0] || null,
    });
  } catch (err) {
    next(err);
  }
};

// GET /api/search/routes - search by from, to, date, passengers
const searchRoutes = async (req, res, next) => {
  try {
    const { from, to, date, passengers = 1 } = req.query;
    if (!from || !to) return error(res, 'From and To locations are required', 400);

    const [routes] = await pool.query(
      `SELECT r.id, r.slug, r.distance_km, r.duration_minutes,
              fl.name as from_name, fl.city as from_city,
              tl.name as to_name, tl.city as to_city
       FROM routes r
       JOIN locations fl ON fl.id = r.from_location_id
       JOIN locations tl ON tl.id = r.to_location_id
       WHERE (fl.id = ? OR fl.slug = ?) AND (tl.id = ? OR tl.slug = ?)
       AND r.is_active = 1 AND r.deleted_at IS NULL`,
      [from, from, to, to]
    );

    if (!routes.length) {
      return success(res, [], 'No routes found for this combination');
    }

    // Get vehicles and pricing for each route
    const results = await Promise.all(routes.map(async (route) => {
      const [vehicles] = await pool.query(
        `SELECT v.id, v.name, v.type, v.capacity, v.amenities, v.is_ac,
                rv.custom_price as base_price
         FROM route_vehicles rv
         JOIN vehicles v ON v.id = rv.vehicle_id
         WHERE rv.route_id = ? AND rv.is_active = 1 AND v.is_active = 1
         AND v.capacity >= ?
         ORDER BY rv.custom_price ASC`,
        [route.id, passengers]
      );

      // Get best offer for route
      const [offers] = await pool.query(
        `SELECT discount_type, discount_value, maximum_discount, banner_text
         FROM offers
         WHERE is_active = 1 AND start_date <= CURDATE() AND end_date >= CURDATE()
         AND (route_id = ? OR route_id IS NULL)
         ORDER BY discount_value DESC LIMIT 1`,
        [route.id]
      );

      return { ...route, vehicles, best_offer: offers[0] || null };
    }));

    return success(res, results);
  } catch (err) {
    next(err);
  }
};

module.exports = { getRoutes, getRouteBySlug, searchRoutes };
