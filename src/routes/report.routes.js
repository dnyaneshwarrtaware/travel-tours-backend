const router = require('express').Router();
const { pool } = require('../config/database');
const { success } = require('../utils/response');
const { verifyAdmin, requirePermission } = require('../middleware/auth');

router.use(verifyAdmin, requirePermission('reports.view'));

// Route views / WhatsApp clicks / Call clicks per route, sourced from analytics_events
router.get('/route-engagement', async (req, res, next) => {
  try {
    const [rows] = await pool.query(`
      SELECT r.slug, fl.city as from_city, tl.city as to_city,
        SUM(CASE WHEN ae.event_type = 'route_view' THEN 1 ELSE 0 END) as views,
        SUM(CASE WHEN ae.event_type = 'whatsapp_click' THEN 1 ELSE 0 END) as whatsapp_clicks,
        SUM(CASE WHEN ae.event_type = 'call_click' THEN 1 ELSE 0 END) as call_clicks
      FROM routes r
      JOIN locations fl ON fl.id = r.from_location_id
      JOIN locations tl ON tl.id = r.to_location_id
      LEFT JOIN analytics_events ae ON ae.route_id = r.id
      WHERE r.deleted_at IS NULL
      GROUP BY r.id
      ORDER BY views DESC
    `);
    return success(res, rows);
  } catch(err) { next(err); }
});

// Lead / enquiry conversion funnel
router.get('/lead-conversion', async (req, res, next) => {
  try {
    const [rows] = await pool.query(`
      SELECT status, COUNT(*) as count,
        ROUND(COUNT(*) * 100.0 / (SELECT COUNT(*) FROM enquiries), 2) as percentage
      FROM enquiries GROUP BY status
    `);
    return success(res, rows);
  } catch(err) { next(err); }
});

// Site-wide click/enquiry totals for a date range
router.get('/summary', async (req, res, next) => {
  try {
    const { from, to } = req.query;
    const conditions = [];
    const params = [];
    if (from) { conditions.push('created_at >= ?'); params.push(from); }
    if (to) { conditions.push('created_at <= ?'); params.push(to); }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const [rows] = await pool.query(
      `SELECT event_type, COUNT(*) as count FROM analytics_events ${where} GROUP BY event_type`,
      params
    );
    return success(res, rows);
  } catch(err) { next(err); }
});

module.exports = router;
