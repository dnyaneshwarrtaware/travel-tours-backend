const { pool } = require('../config/database');

/**
 * Core Pricing Engine
 * All pricing calculations happen server-side only.
 * Frontend never calculates or sets the final price.
 */

const calculateRoutePrice = async (routeId, vehicleId, travelDate, passengerCount = 1) => {
  const conn = await pool.getConnection();
  try {
    // 1. Get route
    const [routes] = await conn.query(
      'SELECT id, distance_km, base_price, price_per_km FROM routes WHERE id = ? AND is_active = 1 AND deleted_at IS NULL',
      [routeId]
    );
    if (!routes.length) throw Object.assign(new Error('Route not found'), { statusCode: 404 });

    const route = routes[0];

    // 2. Get vehicle-route custom price or vehicle base price
    const [rvRows] = await conn.query(
      `SELECT rv.custom_price, v.base_price, v.price_per_km, v.capacity
       FROM route_vehicles rv
       JOIN vehicles v ON v.id = rv.vehicle_id
       WHERE rv.route_id = ? AND rv.vehicle_id = ? AND rv.is_active = 1 AND v.is_active = 1`,
      [routeId, vehicleId]
    );
    if (!rvRows.length) throw Object.assign(new Error('Vehicle not available for this route'), { statusCode: 400 });

    const rv = rvRows[0];
    const vehicleBasePrice = rv.custom_price !== null ? parseFloat(rv.custom_price) : parseFloat(rv.base_price);
    const pricePerKm = parseFloat(rv.price_per_km || route.price_per_km);
    const distance = parseFloat(route.distance_km);

    // 3. Look for applicable pricing rule (priority order: highest priority wins)
    const dateObj = travelDate ? new Date(travelDate) : new Date();
    const dayOfWeek = dateObj.getDay(); // 0=Sun, 6=Sat
    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;

    const [rules] = await conn.query(
      `SELECT * FROM pricing_rules
       WHERE route_id = ? AND (vehicle_id = ? OR vehicle_id IS NULL)
       AND is_active = 1
       AND (start_date IS NULL OR start_date <= ?)
       AND (end_date IS NULL OR end_date >= ?)
       ORDER BY priority DESC, id DESC
       LIMIT 1`,
      [routeId, vehicleId, travelDate, travelDate]
    );

    let basePrice = vehicleBasePrice;
    let taxPct = 5; // default GST
    let discountType = null;
    let discountValue = 0;
    let ruleType = 'standard';

    if (rules.length) {
      const rule = rules[0];
      ruleType = rule.rule_type;
      if (rule.base_price !== null) basePrice = parseFloat(rule.base_price);
      if (rule.tax_percentage) taxPct = parseFloat(rule.tax_percentage);
      if (rule.discount_type) {
        discountType = rule.discount_type;
        discountValue = parseFloat(rule.discount_value);
      }
      // Minimum fare check
      if (rule.minimum_fare && basePrice < parseFloat(rule.minimum_fare)) {
        basePrice = parseFloat(rule.minimum_fare);
      }
    }

    // 4. Compute final price
    // base + distance pricing
    const calculatedBase = basePrice + (distance * pricePerKm);
    let subtotal = Math.round(calculatedBase * 100) / 100;

    // Apply discount
    let discountAmount = 0;
    if (discountType === 'percentage' && discountValue > 0) {
      discountAmount = Math.round((subtotal * discountValue / 100) * 100) / 100;
    } else if (discountType === 'fixed' && discountValue > 0) {
      discountAmount = Math.min(discountValue, subtotal);
    }

    const afterDiscount = Math.round((subtotal - discountAmount) * 100) / 100;
    const taxAmount = Math.round((afterDiscount * taxPct / 100) * 100) / 100;
    const totalAmount = Math.round((afterDiscount + taxAmount) * 100) / 100;

    return {
      routeId,
      vehicleId,
      distance_km: distance,
      passengers: passengerCount,
      rule_type: ruleType,
      is_weekend: isWeekend,
      base_price: vehicleBasePrice,
      calculated_base: parseFloat(calculatedBase.toFixed(2)),
      subtotal,
      discount_type: discountType,
      discount_value: discountValue,
      discount_amount: discountAmount,
      tax_percentage: taxPct,
      tax_amount: taxAmount,
      total_amount: totalAmount,
      currency: 'INR',
      breakdown: {
        vehicle_base: vehicleBasePrice,
        distance_charge: parseFloat((distance * pricePerKm).toFixed(2)),
        discount: discountAmount,
        tax: taxAmount,
        total: totalAmount,
      },
    };
  } finally {
    conn.release();
  }
};

const applyOffer = async (pricing, offerId, customerId) => {
  if (!offerId) return pricing;

  const [offers] = await pool.query(
    `SELECT * FROM offers
     WHERE id = ? AND is_active = 1
     AND start_date <= CURDATE() AND end_date >= CURDATE()
     AND (usage_limit IS NULL OR used_count < usage_limit)`,
    [offerId]
  );
  if (!offers.length) return pricing;

  const offer = offers[0];
  const subtotal = pricing.subtotal;

  if (subtotal < parseFloat(offer.minimum_amount)) return pricing;

  let offerDiscount = 0;
  if (offer.discount_type === 'percentage') {
    offerDiscount = Math.round((subtotal * parseFloat(offer.discount_value) / 100) * 100) / 100;
    if (offer.maximum_discount) {
      offerDiscount = Math.min(offerDiscount, parseFloat(offer.maximum_discount));
    }
  } else {
    offerDiscount = parseFloat(offer.discount_value);
  }

  const afterOffer = Math.max(0, subtotal - offerDiscount);
  const taxAmount = Math.round((afterOffer * pricing.tax_percentage / 100) * 100) / 100;
  const total = Math.round((afterOffer + taxAmount) * 100) / 100;

  return {
    ...pricing,
    offer_id: offerId,
    offer_discount: offerDiscount,
    tax_amount: taxAmount,
    total_amount: total,
    breakdown: {
      ...pricing.breakdown,
      offer_discount: offerDiscount,
      tax: taxAmount,
      total,
    },
  };
};

module.exports = { calculateRoutePrice, applyOffer };
