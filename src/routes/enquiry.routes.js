const router = require('express').Router();
const { pool } = require('../config/database');
const { success, error, paginated, buildPaginationMeta } = require('../utils/response');
const { verifyAdmin, requirePermission } = require('../middleware/auth');

router.post('/', async (req, res, next) => {
  try {
    const { name, email, phone, from_location, to_location, travel_date, return_date, passenger_count, vehicle_type, requirements } = req.body;
    if (!name || !phone) return error(res, 'Name and phone required', 400);
    const [result] = await pool.query(
      'INSERT INTO enquiries (name, email, phone, from_location, to_location, travel_date, return_date, passenger_count, vehicle_type, requirements) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [name, email, phone, from_location, to_location, travel_date, return_date, passenger_count, vehicle_type, requirements]
    );
    return success(res, { id: result.insertId }, 'Enquiry submitted successfully', 201);
  } catch(err) { next(err); }
});

router.get('/', verifyAdmin, requirePermission('content.manage'), async (req, res, next) => {
  try {
    const { page = 1, limit = 20, status } = req.query;
    const offset = (page - 1) * limit;
    const conditions = []; const params = [];
    if (status) { conditions.push('status = ?'); params.push(status); }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const [rows] = await pool.query(`SELECT * FROM enquiries ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`, [...params, parseInt(limit), offset]);
    const [[{ total }]] = await pool.query(`SELECT COUNT(*) as total FROM enquiries ${where}`, params);
    return paginated(res, rows, buildPaginationMeta(total, page, limit));
  } catch(err) { next(err); }
});

router.put('/:id', verifyAdmin, requirePermission('content.manage'), async (req, res, next) => {
  try {
    const { status, notes, assigned_to } = req.body;
    await pool.query('UPDATE enquiries SET status = ?, notes = ?, assigned_to = ? WHERE id = ?', [status, notes, assigned_to, req.params.id]);
    return success(res, null, 'Enquiry updated');
  } catch(err) { next(err); }
});

module.exports = router;
