const router = require('express').Router();
const { param } = require('express-validator');
const validate = require('../../middleware/validate');
const { pool } = require('../../config/database');
const { success } = require('../../utils/response');

router.get('/', async (req, res, next) => {
  try {
    const onlyUnread = req.query.unread === 'true';
    const [rows] = await pool.query(
      `SELECT * FROM notifications ${onlyUnread ? 'WHERE is_read = 0' : ''} ORDER BY created_at DESC, id DESC LIMIT 100`
    );
    const [[{ unread }]] = await pool.query('SELECT COUNT(*) AS unread FROM notifications WHERE is_read = 0');
    return res.json({ success: true, message: 'Request successful', data: rows, meta: { unread } });
  } catch (err) { next(err); }
});

router.get('/unread-count', async (req, res, next) => {
  try {
    const [[{ unread }]] = await pool.query('SELECT COUNT(*) AS unread FROM notifications WHERE is_read = 0');
    return success(res, { unread });
  } catch (err) { next(err); }
});

router.post('/read-all', async (req, res, next) => {
  try {
    await pool.query('UPDATE notifications SET is_read = 1 WHERE is_read = 0');
    return success(res, null, 'All notifications marked as read');
  } catch (err) { next(err); }
});

router.post('/:id/read', validate([param('id').isInt()]), async (req, res, next) => {
  try {
    await pool.query('UPDATE notifications SET is_read = 1 WHERE id = ?', [req.params.id]);
    return success(res, null, 'Marked as read');
  } catch (err) { next(err); }
});

module.exports = router;
