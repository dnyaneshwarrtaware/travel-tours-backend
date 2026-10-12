const router = require('express').Router();
const { body, param } = require('express-validator');
const validate = require('../../middleware/validate');
const { pool } = require('../../config/database');
const { success, error } = require('../../utils/response');
const { toFlag, pick, updateClause, diff } = require('../../utils/admin');
const { audit } = require('../../services/audit.service');

const fields = (partial = false) => [
  (partial ? body('name').optional() : body('name')).trim().isLength({ min: 2, max: 150 }).withMessage('Operator name is required'),
  body('phone').optional({ values: 'falsy' }).trim().matches(/^[0-9+\- ]{8,15}$/).withMessage('Invalid phone number'),
  body('email').optional({ values: 'falsy' }).trim().isEmail().withMessage('Invalid email'),
];
const allowed = ['name', 'contact_person', 'phone', 'email', 'address'];

router.get('/', async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT o.*, (SELECT COUNT(*) FROM vehicles v WHERE v.operator_id = o.id AND v.deleted_at IS NULL) AS vehicle_count
       FROM operators o ORDER BY o.is_active DESC, o.name`
    );
    return success(res, rows);
  } catch (err) { next(err); }
});

router.post('/', validate(fields()), async (req, res, next) => {
  try {
    const data = pick(req.body, allowed);
    data.is_active = req.body.is_active === undefined ? 1 : toFlag(req.body.is_active);
    const [r] = await pool.query('INSERT INTO operators SET ?', [data]);
    await audit(req, { action: 'operator.create', module: 'operators', recordId: r.insertId, newValues: data });
    return success(res, { id: r.insertId }, 'Operator created', 201);
  } catch (err) { next(err); }
});

router.put('/:id', validate([param('id').isInt(), ...fields(true)]), async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT * FROM operators WHERE id = ?', [req.params.id]);
    if (!rows.length) return error(res, 'Operator not found', 404);
    const data = pick(req.body, allowed);
    if (req.body.is_active !== undefined) data.is_active = toFlag(req.body.is_active);
    const { oldValues, newValues, changed } = diff(rows[0], data);
    if (!changed) return success(res, null, 'No changes');
    const { sql, values } = updateClause(data);
    await pool.query(`UPDATE operators SET ${sql} WHERE id = ?`, [...values, req.params.id]);
    await audit(req, { action: 'operator.update', module: 'operators', recordId: Number(req.params.id), oldValues, newValues });
    return success(res, null, 'Operator updated');
  } catch (err) { next(err); }
});

module.exports = router;
