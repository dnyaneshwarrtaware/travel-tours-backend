const router = require('express').Router();
const { body, param } = require('express-validator');
const validate = require('../../middleware/validate');
const { requirePermission } = require('../../middleware/auth');
const { pool, withTransaction } = require('../../config/database');
const { success, error } = require('../../utils/response');
const { audit } = require('../../services/audit.service');

// GET /api/admin/roles - roles with granted permissions + permission catalogue
router.get('/', async (req, res, next) => {
  try {
    const [roles] = await pool.query(
      `SELECT r.id, r.name, r.display_name, r.description, r.is_active,
              (SELECT COUNT(*) FROM users u WHERE u.role_id = r.id AND u.deleted_at IS NULL) AS user_count
       FROM roles r ORDER BY r.id`
    );
    const [grants] = await pool.query('SELECT rp.role_id, p.name FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id');
    const [permissions] = await pool.query('SELECT id, name, module, action, description FROM permissions ORDER BY module, action');
    roles.forEach(r => {
      r.permissions = r.name === 'super_admin' ? permissions.map(p => p.name) : grants.filter(g => g.role_id === r.id).map(g => g.name);
      r.locked = r.name === 'super_admin';
    });
    return success(res, { roles, permissions });
  } catch (err) { next(err); }
});

// PUT /api/admin/roles/:id/permissions { permissions: [names] }
router.put('/:id/permissions', requirePermission('roles.manage'), validate([
  param('id').isInt().toInt(),
  body('permissions').isArray().withMessage('Permissions must be a list'),
]), async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT * FROM roles WHERE id = ?', [req.params.id]);
    if (!rows.length) return error(res, 'Role not found', 404);
    const role = rows[0];
    if (role.name === 'super_admin') return error(res, 'Super Admin always has every permission', 400);
    if (req.adminUser.role_id === role.id) return error(res, 'You cannot change the permissions of your own role', 400);

    const [valid] = await pool.query('SELECT id, name FROM permissions WHERE name IN (?)', [req.body.permissions.length ? req.body.permissions : ['']]);
    await withTransaction(async (conn) => {
      const [old] = await conn.query('SELECT p.name FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = ?', [role.id]);
      await conn.query('DELETE FROM role_permissions WHERE role_id = ?', [role.id]);
      if (valid.length) await conn.query('INSERT INTO role_permissions (role_id, permission_id) VALUES ?', [valid.map(p => [role.id, p.id])]);
      await audit(req, { action: 'role.permissions.update', module: 'roles', recordId: role.id, oldValues: old.map(o => o.name), newValues: valid.map(v => v.name) }, conn);
    });
    return success(res, null, `Permissions updated for ${role.display_name}`);
  } catch (err) { next(err); }
});

module.exports = router;
