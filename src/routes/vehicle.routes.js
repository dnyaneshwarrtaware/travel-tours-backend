const router = require('express').Router();
const { pool } = require('../config/database');
const { success, error } = require('../utils/response');
const { verifyAdmin, requirePermission } = require('../middleware/auth');

router.get('/', async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, name, type, registration_number, capacity, is_ac, seat_type, amenities, images, description
       FROM vehicles WHERE is_active = 1 AND deleted_at IS NULL ORDER BY sort_order ASC, name ASC`
    );
    return success(res, rows);
  } catch(err) { next(err); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT * FROM vehicles WHERE id = ? AND deleted_at IS NULL', [req.params.id]);
    if (!rows.length) return error(res, 'Vehicle not found', 404);
    return success(res, rows[0]);
  } catch(err) { next(err); }
});

// Admin writes go through the same validated/audited handlers as /api/admin/vehicles
const adminVehicles = require('./admin/vehicles');
router.post('/', verifyAdmin, requirePermission('vehicles.manage'), (req, res, next) => adminVehicles(req, res, next));
router.put('/:id', verifyAdmin, requirePermission('vehicles.manage'), (req, res, next) => adminVehicles(req, res, next));

module.exports = router;
