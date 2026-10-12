const router = require('express').Router();
const slugify = require('slugify');
const { body, param } = require('express-validator');
const validate = require('../../middleware/validate');
const { pool } = require('../../config/database');
const { success, error } = require('../../utils/response');
const { toFlag, pick, updateClause, diff } = require('../../utils/admin');
const { audit } = require('../../services/audit.service');

// Factory: express-validator chains are mutable, so build fresh ones per route
const fields = (partial = false) => {
  const req = (chain) => (partial ? chain.optional() : chain);
  return [
    req(body('name')).trim().isLength({ min: 2, max: 150 }).withMessage('Location name is required'),
    req(body('city')).trim().isLength({ min: 2, max: 100 }).withMessage('City is required'),
    req(body('state')).trim().isLength({ min: 2, max: 100 }).withMessage('State is required'),
    body('latitude').optional({ values: 'falsy' }).isFloat({ min: -90, max: 90 }).withMessage('Invalid latitude'),
    body('longitude').optional({ values: 'falsy' }).isFloat({ min: -180, max: 180 }).withMessage('Invalid longitude'),
  ];
};

const uniqueSlug = async (base, excludeId = 0) => {
  const root = slugify(base, { lower: true, strict: true }) || 'location';
  let slug = root;
  for (let i = 2; ; i++) {
    const [rows] = await pool.query('SELECT id FROM locations WHERE slug = ? AND id <> ?', [slug, excludeId]);
    if (!rows.length) return slug;
    slug = `${root}-${i}`;
  }
};

// GET /api/admin/locations
router.get('/', async (req, res, next) => {
  try {
    const { q, status } = req.query;
    const cond = []; const params = [];
    if (q) { cond.push('(l.name LIKE ? OR l.city LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
    if (status === 'active') cond.push('l.is_active = 1');
    if (status === 'inactive') cond.push('l.is_active = 0');
    const [rows] = await pool.query(
      `SELECT l.*, (SELECT COUNT(DISTINCT rs.route_id) FROM route_stops rs WHERE rs.location_id = l.id AND rs.is_active = 1) AS route_count
       FROM locations l ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''} ORDER BY l.is_active DESC, l.city ASC, l.name ASC`,
      params
    );
    return success(res, rows);
  } catch (err) { next(err); }
});

const create = async (req, res, next) => {
  try {
    const data = pick(req.body, ['name', 'city', 'state', 'latitude', 'longitude']);
    data.name = data.name.trim(); data.city = data.city.trim(); data.state = data.state.trim();
    data.latitude = data.latitude || null; data.longitude = data.longitude || null;
    data.is_popular = toFlag(req.body.is_popular);
    data.is_active = req.body.is_active === undefined ? 1 : toFlag(req.body.is_active);
    const [dupe] = await pool.query('SELECT id FROM locations WHERE name = ? AND city = ?', [data.name, data.city]);
    if (dupe.length) return error(res, 'A location with this name already exists in this city', 409);
    data.slug = await uniqueSlug(data.name === data.city ? data.city : `${data.city}-${data.name}`);
    const [r] = await pool.query('INSERT INTO locations SET ?', [data]);
    await audit(req, { action: 'location.create', module: 'locations', recordId: r.insertId, newValues: data });
    return success(res, { id: r.insertId, slug: data.slug }, 'Location created', 201);
  } catch (err) { next(err); }
};

const update = async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT * FROM locations WHERE id = ?', [req.params.id]);
    if (!rows.length) return error(res, 'Location not found', 404);
    const data = pick(req.body, ['name', 'city', 'state', 'latitude', 'longitude']);
    ['latitude', 'longitude'].forEach(k => { if (data[k] === '') data[k] = null; });
    if (req.body.is_popular !== undefined) data.is_popular = toFlag(req.body.is_popular);
    if (req.body.is_active !== undefined) data.is_active = toFlag(req.body.is_active);
    const { oldValues, newValues, changed } = diff(rows[0], data);
    if (!changed) return success(res, null, 'No changes');
    const { sql, values } = updateClause(data);
    await pool.query(`UPDATE locations SET ${sql} WHERE id = ?`, [...values, req.params.id]);
    await audit(req, { action: 'location.update', module: 'locations', recordId: Number(req.params.id), oldValues, newValues });
    return success(res, null, 'Location updated');
  } catch (err) { next(err); }
};

router.post('/', validate(fields()), create);
router.put('/:id', validate([param('id').isInt(), ...fields(true)]), update);

// PATCH /api/admin/locations/:id/status { is_active }
router.patch('/:id/status', validate([param('id').isInt(), body('is_active').isBoolean()]), async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT id, name, is_active FROM locations WHERE id = ?', [req.params.id]);
    if (!rows.length) return error(res, 'Location not found', 404);
    const isActive = toFlag(req.body.is_active);
    await pool.query('UPDATE locations SET is_active = ? WHERE id = ?', [isActive, req.params.id]);
    await audit(req, { action: isActive ? 'location.activate' : 'location.deactivate', module: 'locations', recordId: rows[0].id, oldValues: { is_active: rows[0].is_active }, newValues: { is_active: isActive } });
    return success(res, null, isActive ? 'Location activated' : 'Location deactivated');
  } catch (err) { next(err); }
});

module.exports = router;
module.exports.create = [validate(fields()), create];
