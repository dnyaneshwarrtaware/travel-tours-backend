const router = require('express').Router();
const { pool } = require('../config/database');
const { success, error, paginated, buildPaginationMeta } = require('../utils/response');
const { verifyAdmin, requirePermission } = require('../middleware/auth');

router.get('/', async (req, res, next) => {
  try {
    const { page = 1, limit = 12, category, featured } = req.query;
    const offset = (page - 1) * limit;
    const conditions = ['is_active = 1', 'deleted_at IS NULL'];
    const params = [];
    if (category) { conditions.push('category = ?'); params.push(category); }
    if (featured === 'true') { conditions.push('is_featured = 1'); }
    const [rows] = await pool.query(
      `SELECT id, name, slug, category, destination, duration_days, duration_nights, base_price, offer_price, thumbnail, is_featured, seo_title, meta_desc
       FROM packages WHERE ${conditions.join(' AND ')} ORDER BY is_featured DESC, sort_order ASC LIMIT ? OFFSET ?`,
      [...params, parseInt(limit), offset]
    );
    const [[{ total }]] = await pool.query(`SELECT COUNT(*) as total FROM packages WHERE ${conditions.join(' AND ')}`, params);
    return paginated(res, rows, buildPaginationMeta(total, page, limit));
  } catch(err) { next(err); }
});

router.get('/:slug', async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT * FROM packages WHERE slug = ? AND is_active = 1 AND deleted_at IS NULL', [req.params.slug]);
    if (!rows.length) return error(res, 'Package not found', 404);
    const pkg = rows[0];
    const [itinerary] = await pool.query('SELECT * FROM package_itinerary WHERE package_id = ? ORDER BY day_number ASC', [pkg.id]);
    const [dates] = await pool.query('SELECT * FROM package_dates WHERE package_id = ? AND is_active = 1 AND end_date >= CURDATE() ORDER BY start_date ASC LIMIT 6', [pkg.id]);
    return success(res, { ...pkg, itinerary, available_dates: dates });
  } catch(err) { next(err); }
});

router.post('/', verifyAdmin, requirePermission('content.manage'), async (req, res, next) => {
  try {
    const slugify = require('slugify');
    const { name, category, destination, duration_days, duration_nights, base_price, offer_price, description, highlights, inclusions, exclusions, terms, min_persons, is_featured, seo_title, meta_desc } = req.body;
    let slug = slugify(name, { lower: true, strict: true });
    const [existing] = await pool.query('SELECT slug FROM packages WHERE slug LIKE ?', [`${slug}%`]);
    if (existing.length) slug = `${slug}-${existing.length + 1}`;
    const [result] = await pool.query(
      `INSERT INTO packages (name, slug, category, destination, duration_days, duration_nights, base_price, offer_price, description, highlights, inclusions, exclusions, terms, min_persons, is_featured, seo_title, meta_desc, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [name, slug, category, destination, duration_days, duration_nights, base_price, offer_price, description,
       JSON.stringify(highlights || []), JSON.stringify(inclusions || []), JSON.stringify(exclusions || []),
       terms, min_persons || 1, is_featured || 0, seo_title, meta_desc, req.user.id]
    );
    return success(res, { id: result.insertId, slug }, 'Package created', 201);
  } catch(err) { next(err); }
});

module.exports = router;
