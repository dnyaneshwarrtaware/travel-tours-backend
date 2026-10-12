const router = require('express').Router();
const bcrypt = require('bcrypt');
const { body, param } = require('express-validator');
const validate = require('../../middleware/validate');
const { pool } = require('../../config/database');
const { success, error } = require('../../utils/response');
const { toFlag, diff, updateClause } = require('../../utils/admin');
const { audit } = require('../../services/audit.service');

const fields = (partial = false) => {
  const r = (c) => (partial ? c.optional() : c);
  return [
    r(body('name')).trim().isLength({ min: 2, max: 150 }).withMessage('Name is required'),
    r(body('email')).trim().isEmail().withMessage('Valid email is required').customSanitizer(v => String(v).toLowerCase()),
    body('phone').optional({ values: 'falsy' }).trim().matches(/^[0-9+\- ]{8,15}$/).withMessage('Invalid phone'),
    r(body('role_id')).isInt({ min: 1 }).withMessage('Select a role').toInt(),
    (partial ? body('password').optional({ values: 'falsy' }) : body('password'))
      .isLength({ min: 8, max: 100 }).withMessage('Password must be at least 8 characters')
      .matches(/[A-Za-z]/).withMessage('Password must contain letters and numbers')
      .matches(/\d/).withMessage('Password must contain letters and numbers'),
  ];
};

const assertRoleAssignable = async (req, roleId) => {
  const [rows] = await pool.query('SELECT name FROM roles WHERE id = ? AND is_active = 1', [roleId]);
  if (!rows.length) return 'Role not found';
  if (rows[0].name === 'super_admin' && req.adminUser.role_name !== 'super_admin') return 'Only a Super Admin can assign the Super Admin role';
  return null;
};

router.get('/', async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT u.id, u.name, u.email, u.phone, u.role_id, u.is_active, u.last_login_at, u.created_at, r.name AS role, r.display_name AS role_name
       FROM users u JOIN roles r ON r.id = u.role_id WHERE u.deleted_at IS NULL ORDER BY u.is_active DESC, u.name`
    );
    return success(res, rows);
  } catch (err) { next(err); }
});

router.post('/', validate(fields()), async (req, res, next) => {
  try {
    const roleErr = await assertRoleAssignable(req, req.body.role_id);
    if (roleErr) return error(res, roleErr, 403);
    const data = {
      name: req.body.name, email: req.body.email, phone: req.body.phone || null, role_id: req.body.role_id,
      password_hash: await bcrypt.hash(req.body.password, 12), is_active: req.body.is_active === undefined ? 1 : toFlag(req.body.is_active),
    };
    const [r] = await pool.query('INSERT INTO users SET ?', [data]);
    const { password_hash, ...logged } = data;
    await audit(req, { action: 'user.create', module: 'users', recordId: r.insertId, newValues: logged });
    return success(res, { id: r.insertId }, 'User created', 201);
  } catch (err) { next(err); }
});

router.put('/:id', validate([param('id').isInt().toInt(), ...fields(true)]), async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL', [req.params.id]);
    if (!rows.length) return error(res, 'User not found', 404);
    const user = rows[0];
    const isSelf = user.id === req.user.id;
    const [[target]] = await pool.query('SELECT name FROM roles WHERE id = ?', [user.role_id]);
    if (target.name === 'super_admin' && req.adminUser.role_name !== 'super_admin') return error(res, 'Only a Super Admin can edit a Super Admin', 403);

    const data = {};
    ['name', 'email', 'phone'].forEach(k => { if (req.body[k] !== undefined) data[k] = req.body[k] || null; });
    if (req.body.role_id !== undefined && req.body.role_id !== user.role_id) {
      if (isSelf) return error(res, 'You cannot change your own role', 400);
      const roleErr = await assertRoleAssignable(req, req.body.role_id);
      if (roleErr) return error(res, roleErr, 403);
      data.role_id = req.body.role_id;
    }
    if (req.body.is_active !== undefined) {
      if (isSelf && !toFlag(req.body.is_active)) return error(res, 'You cannot deactivate your own account', 400);
      data.is_active = toFlag(req.body.is_active);
    }
    const { oldValues, newValues } = diff(user, data);
    if (req.body.password) { data.password_hash = await bcrypt.hash(req.body.password, 12); newValues.password = '(changed)'; }
    if (!Object.keys(newValues).length) return success(res, null, 'No changes');
    const { sql, values } = updateClause(data);
    await pool.query(`UPDATE users SET ${sql} WHERE id = ?`, [...values, user.id]);
    await audit(req, { action: 'user.update', module: 'users', recordId: user.id, oldValues, newValues });
    return success(res, null, 'User updated');
  } catch (err) { next(err); }
});

module.exports = router;
