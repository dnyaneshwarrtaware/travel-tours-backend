const jwt = require('jsonwebtoken');
const { pool } = require('../config/database');

const verifyToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, message: 'Access token required' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ success: false, message: 'Token expired', code: 'TOKEN_EXPIRED' });
    }
    return res.status(401).json({ success: false, message: 'Invalid token' });
  }
};

// Loads the permission names granted to a role
const loadPermissions = async (roleId) => {
  const [rows] = await pool.query(
    `SELECT p.name FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = ?`,
    [roleId]
  );
  return rows.map(r => r.name);
};

const verifyAdmin = async (req, res, next) => {
  await verifyToken(req, res, async () => {
    if (req.user.type !== 'admin') {
      return res.status(403).json({ success: false, message: 'Admin access required' });
    }

    // Verify user still exists and is active; role/permissions are read from the DB, not the token
    try {
      const [rows] = await pool.query(
        `SELECT u.id, u.role_id, u.is_active, r.name AS role_name
         FROM users u JOIN roles r ON r.id = u.role_id
         WHERE u.id = ? AND u.deleted_at IS NULL`,
        [req.user.id]
      );
      if (!rows.length || !rows[0].is_active) {
        return res.status(401).json({ success: false, message: 'Account deactivated' });
      }
      req.adminUser = rows[0];
      req.adminUser.permissions = rows[0].role_name === 'super_admin' ? ['*'] : await loadPermissions(rows[0].role_id);
      next();
    } catch (err) {
      next(err);
    }
  });
};

const hasPermission = (adminUser, perm) =>
  !!adminUser && (adminUser.role_name === 'super_admin' || adminUser.permissions.includes(perm));

// Use after verifyAdmin. Passes if the admin has ANY of the listed permissions.
const requirePermission = (...perms) => (req, res, next) => {
  if (perms.some(p => hasPermission(req.adminUser, p))) return next();
  return res.status(403).json({ success: false, message: 'You do not have permission to perform this action' });
};

const verifyCustomer = async (req, res, next) => {
  await verifyToken(req, res, async () => {
    if (req.user.type !== 'customer') {
      return res.status(403).json({ success: false, message: 'Customer login required' });
    }
    try {
      const [rows] = await pool.query('SELECT id, is_active FROM customers WHERE id = ?', [req.user.id]);
      if (!rows.length || !rows[0].is_active) {
        return res.status(401).json({ success: false, message: 'Account deactivated' });
      }
      next();
    } catch (err) { next(err); }
  });
};

const optionalAuth = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    req.user = null;
    return next();
  }
  const token = authHeader.split(' ')[1];
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    req.user = null;
  }
  next();
};

module.exports = { verifyToken, verifyAdmin, verifyCustomer, optionalAuth, requirePermission, hasPermission, loadPermissions };
