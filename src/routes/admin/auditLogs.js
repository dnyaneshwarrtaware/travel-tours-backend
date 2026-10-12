const router = require('express').Router();
const { pool } = require('../../config/database');
const { paginated, buildPaginationMeta } = require('../../utils/response');
const { pagination } = require('../../utils/admin');

// GET /api/admin/audit-logs?module=&action=&user_id=&from=&to=&q=
router.get('/', async (req, res, next) => {
  try {
    const { page, limit, offset } = pagination(req.query, 30);
    const { module, action, user_id, from, to, record_id } = req.query;
    const cond = []; const params = [];
    if (module) { cond.push('a.module = ?'); params.push(module); }
    if (action) { cond.push('a.action LIKE ?'); params.push(`%${action}%`); }
    if (user_id) { cond.push("a.user_id = ? AND a.user_type = 'admin'"); params.push(user_id); }
    if (record_id) { cond.push('a.record_id = ?'); params.push(record_id); }
    if (from) { cond.push('a.created_at >= ?'); params.push(`${from} 00:00:00`); }
    if (to) { cond.push('a.created_at <= ?'); params.push(`${to} 23:59:59`); }
    const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
    const [rows] = await pool.query(
      `SELECT a.id, a.user_id, a.user_type, a.action, a.module, a.record_id, a.old_values, a.new_values, a.ip_address, a.created_at,
              CASE WHEN a.user_type = 'admin' THEN u.name WHEN a.user_type = 'customer' THEN c.name ELSE 'System' END AS user_name
       FROM audit_logs a
       LEFT JOIN users u ON u.id = a.user_id AND a.user_type = 'admin'
       LEFT JOIN customers c ON c.id = a.user_id AND a.user_type = 'customer'
       ${where} ORDER BY a.created_at DESC, a.id DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM audit_logs a ${where}`, params);
    const [modules] = await pool.query('SELECT DISTINCT module FROM audit_logs ORDER BY module');
    return res.json({ success: true, message: 'Request successful', data: rows, meta: { ...buildPaginationMeta(total, page, limit), modules: modules.map(m => m.module) } });
  } catch (err) { next(err); }
});

module.exports = router;
