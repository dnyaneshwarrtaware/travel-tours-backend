const { pool } = require('../config/database');
const logger = require('../utils/logger');

const stringify = (v) => (v === undefined || v === null ? null : JSON.stringify(v));

/**
 * Write an audit log entry. Pass `conn` to write inside an open transaction.
 * Audit failures are logged but never break the business action outside a transaction.
 */
const audit = async (req, { action, module, recordId = null, oldValues = null, newValues = null, userType }, conn = null) => {
  const db = conn || pool;
  const type = userType || (req?.user?.type === 'customer' ? 'customer' : req?.user?.type === 'admin' ? 'admin' : 'system');
  const params = [
    req?.user?.id || null, type, action, module, recordId,
    stringify(oldValues), stringify(newValues),
    req?.ip || null, req?.headers?.['user-agent']?.slice(0, 500) || null,
  ];
  const sql = `INSERT INTO audit_logs (user_id, user_type, action, module, record_id, old_values, new_values, ip_address, user_agent)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  if (conn) return db.query(sql, params);
  try { await db.query(sql, params); } catch (err) { logger.error(`Audit log failed: ${err.message}`); }
};

module.exports = { audit };
