const router = require('express').Router();
const { pool } = require('../config/database');
const { success, error } = require('../utils/response');
const { verifyAdmin, requirePermission } = require('../middleware/auth');

router.get('/', async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT id, name, city, state, slug, latitude, longitude, is_popular FROM locations WHERE is_active = 1 ORDER BY is_popular DESC, city ASC');
    return success(res, rows);
  } catch(err) { next(err); }
});

router.get('/popular', async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT id, name, city, slug FROM locations WHERE is_active = 1 AND is_popular = 1 ORDER BY city ASC');
    return success(res, rows);
  } catch(err) { next(err); }
});

router.get('/:slug', async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT * FROM locations WHERE slug = ? AND is_active = 1', [req.params.slug]);
    if (!rows.length) return error(res, 'Location not found', 404);
    return success(res, rows[0]);
  } catch(err) { next(err); }
});

// Admin create (same handler as POST /api/admin/locations - validated and audited)
router.post('/', verifyAdmin, requirePermission('locations.manage'), ...require('./admin/locations').create);

module.exports = router;
