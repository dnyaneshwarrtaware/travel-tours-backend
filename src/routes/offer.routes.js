const router = require('express').Router();
const { pool } = require('../config/database');
const { success, error } = require('../utils/response');
const { verifyAdmin, requirePermission } = require('../middleware/auth');

router.get('/', async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, name, code, offer_type, discount_type, discount_value, maximum_discount, end_date, banner_text, is_featured
       FROM offers WHERE is_active = 1 AND start_date <= CURDATE() AND end_date >= CURDATE()
       ORDER BY is_featured DESC, id DESC LIMIT 20`
    );
    return success(res, rows);
  } catch(err) { next(err); }
});

router.post('/', verifyAdmin, requirePermission('content.manage'), async (req, res, next) => {
  try {
    const { name, code, offer_type, discount_type, discount_value, minimum_amount, maximum_discount, applicable_to, route_id, package_id, usage_limit, per_customer_limit, start_date, end_date, description, banner_text, is_featured } = req.body;
    const [result] = await pool.query(
      `INSERT INTO offers (name, code, offer_type, discount_type, discount_value, minimum_amount, maximum_discount, applicable_to, route_id, package_id, usage_limit, per_customer_limit, start_date, end_date, description, banner_text, is_featured, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [name, code.toUpperCase(), offer_type, discount_type, discount_value, minimum_amount || 0, maximum_discount, applicable_to || 'both', route_id, package_id, usage_limit, per_customer_limit || 1, start_date, end_date, description, banner_text, is_featured || 0, req.user.id]
    );
    return success(res, { id: result.insertId }, 'Offer created', 201);
  } catch(err) { next(err); }
});

router.put('/:id', verifyAdmin, requirePermission('content.manage'), async (req, res, next) => {
  try {
    const allowed = ['name','discount_type','discount_value','minimum_amount','maximum_discount','start_date','end_date','usage_limit','banner_text','is_featured','is_active'];
    const updates = []; const values = [];
    allowed.forEach(k => { if (req.body[k] !== undefined) { updates.push(`${k} = ?`); values.push(req.body[k]); }});
    values.push(req.params.id);
    await pool.query(`UPDATE offers SET ${updates.join(', ')} WHERE id = ?`, values);
    return success(res, null, 'Offer updated');
  } catch(err) { next(err); }
});

module.exports = router;
