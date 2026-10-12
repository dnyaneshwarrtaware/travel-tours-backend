const router = require('express').Router();
const { pool } = require('../config/database');
const { success } = require('../utils/response');
const { verifyAdmin, requirePermission } = require('../middleware/auth');

router.get('/:pageType/:pageId', async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT * FROM seo_metadata WHERE page_type = ? AND page_id = ?', [req.params.pageType, req.params.pageId]);
    return success(res, rows[0] || null);
  } catch(err) { next(err); }
});

router.put('/:pageType/:pageId', verifyAdmin, requirePermission('content.manage'), async (req, res, next) => {
  try {
    const { seo_title, meta_desc, meta_keywords, canonical_url, og_title, og_desc, og_image, robots, schema_markup } = req.body;
    await pool.query(
      `INSERT INTO seo_metadata (page_type, page_id, seo_title, meta_desc, meta_keywords, canonical_url, og_title, og_desc, og_image, robots, schema_markup)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE seo_title=VALUES(seo_title), meta_desc=VALUES(meta_desc), meta_keywords=VALUES(meta_keywords), canonical_url=VALUES(canonical_url), og_title=VALUES(og_title), og_desc=VALUES(og_desc), og_image=VALUES(og_image), robots=VALUES(robots), schema_markup=VALUES(schema_markup)`,
      [req.params.pageType, req.params.pageId, seo_title, meta_desc, meta_keywords, canonical_url, og_title, og_desc, og_image, robots, JSON.stringify(schema_markup)]
    );
    return success(res, null, 'SEO metadata updated');
  } catch(err) { next(err); }
});

module.exports = router;
