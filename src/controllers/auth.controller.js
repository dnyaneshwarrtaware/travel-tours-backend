const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { pool } = require('../config/database');
const { success, error } = require('../utils/response');
const { loadPermissions } = require('../middleware/auth');
const { audit } = require('../services/audit.service');
const { cleanPhone } = require('../services/booking.service');

const generateTokens = (payload) => {
  const accessToken = jwt.sign(payload, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  });
  const refreshToken = jwt.sign(payload, process.env.JWT_REFRESH_SECRET, {
    expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '30d',
  });
  return { accessToken, refreshToken };
};

const permissionsFor = async (user) =>
  (user.role_name === 'super_admin' ? ['*'] : loadPermissions(user.role_id));

// Admin Login
const adminLogin = async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return error(res, 'Email and password required', 400);
    }

    const [rows] = await pool.query(
      `SELECT u.*, r.name as role_name FROM users u
       JOIN roles r ON r.id = u.role_id
       WHERE u.email = ? AND u.deleted_at IS NULL`,
      [email.toLowerCase().trim()]
    );

    if (!rows.length) return error(res, 'Invalid credentials', 401);

    const user = rows[0];
    if (!user.is_active) return error(res, 'Account is deactivated', 401);

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return error(res, 'Invalid credentials', 401);

    await pool.query('UPDATE users SET last_login_at = NOW() WHERE id = ?', [user.id]);

    const payload = { id: user.id, email: user.email, type: 'admin', role: user.role_name };
    const { accessToken, refreshToken } = generateTokens(payload);

    return success(res, {
      token: accessToken,
      refreshToken,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role_name,
        avatar: user.avatar,
        permissions: await permissionsFor(user),
      },
    }, 'Login successful');
  } catch (err) {
    next(err);
  }
};

// Refresh Token
const refreshToken = async (req, res, next) => {
  try {
    const { refreshToken: token } = req.body;
    if (!token) return error(res, 'Refresh token required', 400);

    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_REFRESH_SECRET);
    } catch {
      return error(res, 'Invalid or expired refresh token', 401);
    }

    const { accessToken, refreshToken: newRefresh } = generateTokens({
      id: decoded.id,
      email: decoded.email,
      type: decoded.type,
      role: decoded.role,
    });

    return success(res, { token: accessToken, refreshToken: newRefresh }, 'Token refreshed');
  } catch (err) {
    next(err);
  }
};

// Get current admin profile
const getProfile = async (req, res, next) => {
  try {
    const { id } = req.user;
    const [rows] = await pool.query(
      'SELECT u.id, u.name, u.email, u.phone, u.avatar, u.last_login_at, r.name as role FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?',
      [id]
    );
    return success(res, { ...rows[0], permissions: req.adminUser.permissions });
  } catch (err) {
    next(err);
  }
};

// ---------------- Customer accounts ----------------

const customerPayload = (c) => ({ id: c.id, email: c.email, type: 'customer' });
const customerUser = (c) => ({ id: c.id, name: c.name, email: c.email, phone: c.phone });

// POST /api/auth/register
const customerRegister = async (req, res, next) => {
  try {
    const { name, email, phone, password } = req.body;
    const cleanEmail = String(email).toLowerCase().trim();
    const [existing] = await pool.query(
      'SELECT id FROM customers WHERE email = ? AND password_hash IS NOT NULL', [cleanEmail]
    );
    if (existing.length) return error(res, 'An account with this email already exists. Please sign in.', 409);

    const hash = await bcrypt.hash(password, 12);
    const [r] = await pool.query(
      'INSERT INTO customers (name, email, phone, password_hash, last_login_at) VALUES (?, ?, ?, ?, NOW())',
      [name.trim(), cleanEmail, cleanPhone(phone), hash]
    );
    const customer = { id: r.insertId, name: name.trim(), email: cleanEmail, phone: cleanPhone(phone) };
    const { accessToken, refreshToken } = generateTokens(customerPayload(customer));
    await audit({ ip: req.ip, headers: req.headers, user: { id: customer.id, type: 'customer' } },{ action: 'customer.register', module: 'customers', recordId: customer.id });
    return success(res, { token: accessToken, refreshToken, user: customerUser(customer) }, 'Account created', 201);
  } catch (err) {
    next(err);
  }
};

// POST /api/auth/login
const customerLogin = async (req, res, next) => {
  try {
    const { email, password } = req.body;
    const [rows] = await pool.query(
      'SELECT * FROM customers WHERE email = ? AND password_hash IS NOT NULL ORDER BY id DESC LIMIT 1',
      [String(email).toLowerCase().trim()]
    );
    if (!rows.length) return error(res, 'Invalid email or password', 401);
    const c = rows[0];
    if (!c.is_active) return error(res, 'Account is deactivated', 401);
    if (!(await bcrypt.compare(password, c.password_hash))) return error(res, 'Invalid email or password', 401);

    await pool.query('UPDATE customers SET last_login_at = NOW() WHERE id = ?', [c.id]);
    const { accessToken, refreshToken } = generateTokens(customerPayload(c));
    return success(res, { token: accessToken, refreshToken, user: customerUser(c) }, 'Login successful');
  } catch (err) {
    next(err);
  }
};

// GET /api/auth/customer/me
const customerProfile = async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT id, name, email, phone FROM customers WHERE id = ?', [req.user.id]);
    return success(res, rows[0]);
  } catch (err) {
    next(err);
  }
};

module.exports = { adminLogin, refreshToken, getProfile, customerRegister, customerLogin, customerProfile };
