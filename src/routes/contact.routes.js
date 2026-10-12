const router = require('express').Router();
const { pool } = require('../config/database');
const { success, error } = require('../utils/response');

router.post('/', async (req, res, next) => {
  try {
    const { name, email, phone, subject, message } = req.body;
    if (!name || !message) return error(res, 'Name and message required', 400);
    await pool.query('INSERT INTO contact_messages (name, email, phone, subject, message) VALUES (?, ?, ?, ?, ?)', [name, email, phone, subject, message]);
    return success(res, null, 'Message sent successfully', 201);
  } catch(err) { next(err); }
});

module.exports = router;
