const router = require('express').Router();
const { pool } = require('../config/database');
const { calculateRoutePrice, applyOffer } = require('../services/pricingEngine');
const { success, error } = require('../utils/response');
const { optionalAuth } = require('../middleware/auth');

// POST /api/pricing/calculate
// Server-side price calculation. If an active offer applies to the route,
// it is applied automatically -- the frontend never computes or overrides the final price.
router.post('/calculate', optionalAuth, async (req, res, next) => {
  try {
    const { route_id, vehicle_id, travel_date, passenger_count } = req.body;
    if (!route_id || !vehicle_id) return error(res, 'route_id and vehicle_id required', 400);
    let pricing = await calculateRoutePrice(route_id, vehicle_id, travel_date, passenger_count);

    const [offers] = await pool.query(
      `SELECT id FROM offers
       WHERE is_active = 1 AND start_date <= CURDATE() AND end_date >= CURDATE()
       AND (usage_limit IS NULL OR used_count < usage_limit)
       AND (route_id = ? OR (route_id IS NULL AND applicable_to IN ('route','both')))
       ORDER BY route_id IS NULL ASC, discount_value DESC
       LIMIT 1`,
      [route_id]
    );
    if (offers.length) {
      pricing = await applyOffer(pricing, offers[0].id, req.user?.id);
    }

    return success(res, pricing);
  } catch(err) { next(err); }
});

module.exports = router;
