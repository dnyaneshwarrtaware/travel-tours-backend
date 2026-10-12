const router = require('express').Router();
const { pool } = require('../config/database');
const { success, error, paginated, buildPaginationMeta } = require('../utils/response');
const { verifyAdmin, requirePermission } = require('../middleware/auth');

router.get('/', async (req, res, next) => {
  try {
    const { page = 1, limit = 9, category } = req.query;
    const offset = (page - 1) * limit;
    const cond = ['b.status = "published"']; const params = [];
    if (category) { cond.push('c.slug = ?'); params.push(category); }
    const [rows] = await pool.query(
      `SELECT b.id, b.title, b.slug, b.excerpt, b.featured_image, b.published_at, b.read_time, b.views,
              c.name as category_name, c.slug as category_slug, u.name as author_name
       FROM blogs b LEFT JOIN blog_categories c ON c.id = b.category_id LEFT JOIN users u ON u.id = b.author_id
       WHERE ${cond.join(' AND ')} ORDER BY b.published_at DESC LIMIT ? OFFSET ?`,
      [...params, parseInt(limit), offset]
    );
    const [[{ total }]] = await pool.query(`SELECT COUNT(*) as total FROM blogs b LEFT JOIN blog_categories c ON c.id = b.category_id WHERE ${cond.join(' AND ')}`, params);
    return paginated(res, rows, buildPaginationMeta(total, page, limit));
  } catch(err) { next(err); }
});

router.get('/categories', async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT * FROM blog_categories WHERE is_active = 1');
    return success(res, rows);
  } catch(err) { next(err); }
});

router.get('/:slug', async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT b.*, c.name as category_name, c.slug as category_slug, u.name as author_name
       FROM blogs b LEFT JOIN blog_categories c ON c.id = b.category_id LEFT JOIN users u ON u.id = b.author_id
       WHERE b.slug = ? AND b.status = 'published'`, [req.params.slug]
    );
    if (!rows.length) return error(res, 'Blog not found', 404);
    await pool.query('UPDATE blogs SET views = views + 1 WHERE id = ?', [rows[0].id]);
    return success(res, rows[0]);
  } catch(err) { next(err); }
});

router.post('/', verifyAdmin, requirePermission('content.manage'), async (req, res, next) => {
  try {
    const slugify = require('slugify');
    const { title, content, excerpt, category_id, tags, status, seo_title, meta_desc, featured_image } = req.body;
    let slug = slugify(title, { lower: true, strict: true });
    const [existing] = await pool.query('SELECT slug FROM blogs WHERE slug LIKE ?', [`${slug}%`]);
    if (existing.length) slug = `${slug}-${existing.length + 1}`;
    const readTime = Math.ceil((content || '').split(' ').length / 200);
    const [result] = await pool.query(
      'INSERT INTO blogs (category_id, author_id, title, slug, excerpt, content, featured_image, tags, status, published_at, seo_title, meta_desc, read_time) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [category_id, req.user.id, title, slug, excerpt, content, featured_image, JSON.stringify(tags || []), status || 'draft', status === 'published' ? new Date() : null, seo_title, meta_desc, readTime]
    );
    return success(res, { id: result.insertId, slug }, 'Blog created', 201);
  } catch(err) { next(err); }
});

module.exports = router;
