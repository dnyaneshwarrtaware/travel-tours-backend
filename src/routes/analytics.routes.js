const router = require('express').Router();
const { pool } = require('../config/database');
const { success, error } = require('../utils/response');

const EVENT_TYPES = ['route_view', 'package_view', 'offer_view', 'whatsapp_click', 'call_click', 'enquiry_submit'];

// POST /api/analytics/events - public, fire-and-forget click/view tracking
// No PII is collected: only event type, an optional route/package id, and a client-generated session id.
router.post('/events', async (req, res, next) => {
  try {
    const { event_type, route_id, package_id, session_id } = req.body;
    if (!EVENT_TYPES.includes(event_type)) return error(res, 'Invalid event_type', 400);

    await pool.query(
      'INSERT INTO analytics_events (event_type, route_id, package_id, session_id) VALUES (?, ?, ?, ?)',
      [event_type, route_id || null, package_id || null, session_id || null]
    );
    return success(res, null, 'Event recorded', 201);
  } catch (err) { next(err); }
});

module.exports = router;
