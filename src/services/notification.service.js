const { pool } = require('../config/database');

// Admin-panel notification (shown in Notifications + bell count)
const notify = (conn, { type, title, message = null, link = null }) =>
  (conn || pool).query(
    'INSERT INTO notifications (type, title, message, link) VALUES (?, ?, ?, ?)',
    [type, title, message, link]
  );

module.exports = { notify };
