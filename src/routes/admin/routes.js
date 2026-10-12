const router = require('express').Router();
const slugify = require('slugify');
const { body, param } = require('express-validator');
const validate = require('../../middleware/validate');
const { requirePermission } = require('../../middleware/auth');
const { pool, withTransaction } = require('../../config/database');
const { success, error } = require('../../utils/response');
const httpError = require('../../utils/httpError');
const { toFlag, updateClause, diff } = require('../../utils/admin');
const { isValidTime, normalizeTime, stopOffsets } = require('../../utils/time');
const { audit } = require('../../services/audit.service');
const { getRouteStops } = require('../../services/trip.service');

const id = param('id').isInt({ min: 1 }).toInt();

const routeFields = (partial = false) => {
  const r = (c) => (partial ? c.optional() : c);
  return [
    body('name').optional({ values: 'falsy' }).trim().isLength({ max: 200 }),
    r(body('from_location_id')).isInt({ min: 1 }).withMessage('Select the From location').toInt(),
    r(body('to_location_id')).isInt({ min: 1 }).withMessage('Select the To location').toInt()
      .custom((v, { req }) => v !== Number(req.body.from_location_id) || req.body.from_location_id === undefined)
      .withMessage('From and To cannot be the same'),
    body('distance_km').optional({ values: 'falsy' }).isFloat({ min: 0, max: 5000 }).withMessage('Invalid distance'),
    body('description').optional({ nullable: true }).isString().isLength({ max: 5000 }),
  ];
};

// GET /api/admin/routes
router.get('/', async (req, res, next) => {
  try {
    const { q, status } = req.query;
    const cond = ['r.deleted_at IS NULL']; const params = [];
    if (q) { cond.push('(r.name LIKE ? OR fl.city LIKE ? OR tl.city LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
    if (status === 'active') cond.push('r.is_active = 1');
    if (status === 'inactive') cond.push('r.is_active = 0');
    const [rows] = await pool.query(
      `SELECT r.id, r.name, r.slug, r.from_location_id, r.to_location_id, r.distance_km, r.duration_minutes,
              r.is_active, r.is_popular, r.description, r.updated_at,
              fl.city AS from_city, tl.city AS to_city,
              (SELECT COUNT(*) FROM route_stops rs WHERE rs.route_id = r.id AND rs.is_active = 1) AS stop_count,
              (SELECT COUNT(*) FROM route_fares f WHERE f.route_id = r.id AND f.is_active = 1) AS fare_count,
              (SELECT MIN(f.fare) FROM route_fares f WHERE f.route_id = r.id AND f.is_active = 1) AS min_fare,
              (SELECT COUNT(*) FROM trips t WHERE t.route_id = r.id AND t.travel_date >= CURDATE() AND t.status <> 'cancelled') AS upcoming_trips
       FROM routes r
       JOIN locations fl ON fl.id = r.from_location_id
       JOIN locations tl ON tl.id = r.to_location_id
       WHERE ${cond.join(' AND ')}
       ORDER BY r.is_active DESC, r.sort_order ASC, fl.city, tl.city`,
      params
    );
    return success(res, rows);
  } catch (err) { next(err); }
});

// GET /api/admin/routes/:id - route with all stops (incl. inactive) and fares
router.get('/:id', validate([id]), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT r.*, fl.city AS from_city, tl.city AS to_city FROM routes r
       JOIN locations fl ON fl.id = r.from_location_id JOIN locations tl ON tl.id = r.to_location_id
       WHERE r.id = ? AND r.deleted_at IS NULL`, [req.params.id]
    );
    if (!rows.length) return error(res, 'Route not found', 404);
    const stops = await getRouteStops(req.params.id, { activeOnly: false });
    const [fares] = await pool.query('SELECT id, from_stop_id, to_stop_id, fare, is_active FROM route_fares WHERE route_id = ?', [req.params.id]);
    return success(res, { ...rows[0], stops, fares });
  } catch (err) { next(err); }
});

const assertLocations = async (fromId, toId) => {
  const [locs] = await pool.query('SELECT id, city, name, is_active FROM locations WHERE id IN (?, ?)', [fromId, toId]);
  const from = locs.find(l => l.id === fromId);
  const to = locs.find(l => l.id === toId);
  if (!from || !to) throw httpError(400, 'Selected location does not exist');
  return { from, to };
};

const create = async (req, res, next) => {
  try {
    const { from_location_id: fromId, to_location_id: toId } = req.body;
    const { from, to } = await assertLocations(fromId, toId);

    const [dupe] = await pool.query(
      'SELECT id FROM routes WHERE from_location_id = ? AND to_location_id = ? AND deleted_at IS NULL AND (name <=> ?)',
      [fromId, toId, req.body.name || null]
    );
    if (dupe.length) return error(res, 'This route already exists. Give it a different name to create a variant.', 409);

    const base = slugify(`${from.city}-to-${to.city}${req.body.name ? '-' + req.body.name : ''}`, { lower: true, strict: true });
    let slug = base;
    for (let i = 2; ; i++) {
      const [s] = await pool.query('SELECT id FROM routes WHERE slug = ?', [slug]);
      if (!s.length) break;
      slug = `${base}-${i}`;
    }

    const routeId = await withTransaction(async (conn) => {
      const data = {
        name: req.body.name || null, from_location_id: fromId, to_location_id: toId, slug,
        distance_km: req.body.distance_km || 0, description: req.body.description || null,
        is_popular: toFlag(req.body.is_popular), is_active: req.body.is_active === undefined ? 1 : toFlag(req.body.is_active),
      };
      const [r] = await conn.query('INSERT INTO routes SET ?', [data]);
      // Start with origin and destination stops; admins add intermediate stops next
      await conn.query(
        `INSERT INTO route_stops (route_id, location_id, stop_type, stop_name, stop_order, boarding_allowed, dropping_allowed) VALUES
         (?, ?, 'pickup', ?, 1, 1, 0), (?, ?, 'drop', ?, 2, 0, 1)`,
        [r.insertId, fromId, from.city, r.insertId, toId, to.city]
      );
      await audit(req, { action: 'route.create', module: 'routes', recordId: r.insertId, newValues: data }, conn);
      return r.insertId;
    });
    return success(res, { id: routeId, slug }, 'Route created. Now add stops and fares.', 201);
  } catch (err) { next(err); }
};

const update = async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT * FROM routes WHERE id = ? AND deleted_at IS NULL', [req.params.id]);
    if (!rows.length) return error(res, 'Route not found', 404);
    const route = rows[0];
    const data = {};
    ['name', 'distance_km', 'description', 'seo_title', 'meta_desc', 'meta_keywords', 'image', 'sort_order'].forEach(k => {
      if (req.body[k] !== undefined) data[k] = req.body[k] === '' ? null : req.body[k];
    });
    if (req.body.is_popular !== undefined) data.is_popular = toFlag(req.body.is_popular);
    if (req.body.is_active !== undefined) data.is_active = toFlag(req.body.is_active);

    const fromId = req.body.from_location_id ?? route.from_location_id;
    const toId = req.body.to_location_id ?? route.to_location_id;
    if (fromId !== route.from_location_id || toId !== route.to_location_id) {
      if (fromId === toId) return error(res, 'From and To cannot be the same', 400);
      const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM trips WHERE route_id = ?', [route.id]);
      if (n > 0) return error(res, 'From/To cannot be changed once trips exist for this route. Create a new route instead.', 400);
      await assertLocations(fromId, toId);
      data.from_location_id = fromId; data.to_location_id = toId;
    }

    const { oldValues, newValues, changed } = diff(route, data);
    if (!changed) return success(res, null, 'No changes');
    const { sql, values } = updateClause(data);
    await pool.query(`UPDATE routes SET ${sql} WHERE id = ?`, [...values, route.id]);
    await audit(req, { action: 'route.update', module: 'routes', recordId: route.id, oldValues, newValues });
    return success(res, null, 'Route updated');
  } catch (err) { next(err); }
};

const remove = async (req, res, next) => {
  try {
    const [[{ n }]] = await pool.query(
      `SELECT COUNT(*) AS n FROM bookings b JOIN trips t ON t.id = b.trip_id
       WHERE t.route_id = ? AND t.travel_date >= CURDATE() AND b.booking_status IN ('pending','reserved','confirmed')`,
      [req.params.id]
    );
    if (n > 0) return error(res, `This route has ${n} upcoming active booking(s). Deactivate it instead, or cancel the bookings first.`, 400);
    const [r] = await pool.query('UPDATE routes SET deleted_at = NOW(), is_active = 0 WHERE id = ? AND deleted_at IS NULL', [req.params.id]);
    if (!r.affectedRows) return error(res, 'Route not found', 404);
    await audit(req, { action: 'route.delete', module: 'routes', recordId: Number(req.params.id) });
    return success(res, null, 'Route deleted');
  } catch (err) { next(err); }
};

router.post('/', requirePermission('routes.manage'), validate(routeFields()), create);
router.put('/:id', requirePermission('routes.manage'), validate([id, ...routeFields(true)]), update);
router.delete('/:id', requirePermission('routes.manage'), validate([id]), remove);

// ---------------------------------------------------------------
// PUT /api/admin/routes/:id/stops  { stops: [{ id?, location_id, stop_name, arrival_time, departure_time,
//                                              boarding_allowed, dropping_allowed, landmark, address }] }
// The array order is the stop sequence. Stops missing from the array are
// removed (or deactivated if bookings reference them).
// ---------------------------------------------------------------
router.put('/:id/stops', requirePermission('routes.manage'), validate([
  id,
  body('stops').isArray({ min: 2, max: 30 }).withMessage('A route needs at least 2 stops'),
  body('stops.*.location_id').isInt({ min: 1 }).withMessage('Each stop needs a location').toInt(),
  body('stops.*.stop_name').trim().isLength({ min: 2, max: 200 }).withMessage('Each stop needs a name'),
  body('stops.*.arrival_time').optional({ values: 'falsy' }).custom(isValidTime).withMessage('Invalid arrival time'),
  body('stops.*.departure_time').optional({ values: 'falsy' }).custom(isValidTime).withMessage('Invalid departure time'),
]), async (req, res, next) => {
  try {
    const routeId = req.params.id;
    const [rRows] = await pool.query('SELECT * FROM routes WHERE id = ? AND deleted_at IS NULL', [routeId]);
    if (!rRows.length) return error(res, 'Route not found', 404);
    const route = rRows[0];

    const stops = req.body.stops.map((s, i) => ({
      id: s.id ? Number(s.id) : null,
      location_id: s.location_id,
      stop_name: s.stop_name,
      landmark: s.landmark || null,
      address: s.address || null,
      arrival_time: s.arrival_time ? normalizeTime(s.arrival_time) : null,
      departure_time: s.departure_time ? normalizeTime(s.departure_time) : null,
      boarding_allowed: toFlag(s.boarding_allowed),
      dropping_allowed: toFlag(s.dropping_allowed),
      stop_order: i + 1,
    }));
    const first = stops[0]; const last = stops[stops.length - 1];

    // Structural validation
    if (first.location_id !== route.from_location_id) return error(res, 'The first stop must be the route origin', 400);
    if (last.location_id !== route.to_location_id) return error(res, 'The last stop must be the route destination', 400);
    if (new Set(stops.map(s => s.location_id)).size !== stops.length) return error(res, 'A location can appear only once on a route', 400);
    if (!first.boarding_allowed) return error(res, 'Boarding must be allowed at the first stop', 400);
    if (!last.dropping_allowed) return error(res, 'Dropping must be allowed at the last stop', 400);
    if (!first.departure_time) return error(res, 'The first stop needs a departure time', 400);
    if (!last.arrival_time) return error(res, 'The last stop needs an arrival time', 400);
    for (const s of stops.slice(1, -1)) {
      if (!s.arrival_time && !s.departure_time) return error(res, `Add an arrival or departure time for ${s.stop_name}`, 400);
    }
    first.arrival_time = null; first.dropping_allowed = 0;
    last.departure_time = null; last.boarding_allowed = 0;

    const offsets = stopOffsets(stops);
    const duration = offsets[offsets.length - 1].arrival_offset;
    if (duration <= 0 || duration > 48 * 60) return error(res, 'Stop times look wrong: the journey must take between 1 minute and 48 hours', 400);

    const [locs] = await pool.query('SELECT id FROM locations WHERE id IN (?)', [stops.map(s => s.location_id)]);
    if (locs.length !== stops.length) return error(res, 'One or more stop locations do not exist', 400);

    const result = await withTransaction(async (conn) => {
      const existing = await getRouteStops(routeId, { activeOnly: false, conn });
      const existingIds = new Set(existing.map(s => s.id));
      for (const s of stops) {
        if (s.id && !existingIds.has(s.id)) throw httpError(400, 'A stop does not belong to this route');
      }

      // Stops removed from the list
      const keep = new Set(stops.filter(s => s.id).map(s => s.id));
      let deactivated = 0; let removed = 0; let parkOrder = 200;
      for (const old of existing.filter(s => !keep.has(s.id))) {
        const [[{ n }]] = await conn.query(
          'SELECT COUNT(*) AS n FROM bookings WHERE boarding_stop_id = ? OR dropping_stop_id = ?', [old.id, old.id]
        );
        if (n > 0) {
          await conn.query('UPDATE route_stops SET is_active = 0, stop_order = ? WHERE id = ?', [parkOrder++, old.id]);
          await conn.query('UPDATE route_fares SET is_active = 0 WHERE from_stop_id = ? OR to_stop_id = ?', [old.id, old.id]);
          deactivated++;
        } else {
          await conn.query('DELETE FROM route_stops WHERE id = ?', [old.id]);
          removed++;
        }
      }

      for (const s of stops) {
        const legacyType = s.boarding_allowed && s.dropping_allowed ? 'both' : s.boarding_allowed ? 'pickup' : 'drop';
        const row = {
          location_id: s.location_id, stop_name: s.stop_name, landmark: s.landmark, address: s.address,
          stop_order: s.stop_order, arrival_time: s.arrival_time, departure_time: s.departure_time,
          boarding_allowed: s.boarding_allowed, dropping_allowed: s.dropping_allowed, is_active: 1,
          stop_type: legacyType, pickup_time: s.departure_time, drop_time: s.arrival_time,
        };
        if (s.id) await conn.query('UPDATE route_stops SET ? WHERE id = ?', [row, s.id]);
        else await conn.query('INSERT INTO route_stops SET ?', [{ ...row, route_id: routeId }]);
      }
      // Fares that no longer make sense (wrong order / flags) are deactivated
      await conn.query(
        `UPDATE route_fares f
         JOIN route_stops a ON a.id = f.from_stop_id JOIN route_stops b ON b.id = f.to_stop_id
         SET f.is_active = 0
         WHERE f.route_id = ? AND (a.stop_order >= b.stop_order OR a.boarding_allowed = 0 OR b.dropping_allowed = 0 OR a.is_active = 0 OR b.is_active = 0)`,
        [routeId]
      );
      await conn.query('UPDATE routes SET duration_minutes = ? WHERE id = ?', [duration, routeId]);

      await audit(req, {
        action: 'route.stops.update', module: 'route_stops', recordId: Number(routeId),
        oldValues: existing.filter(s => s.is_active).map(s => ({ id: s.id, stop: s.stop_name, order: s.stop_order, arr: s.arrival_time, dep: s.departure_time, board: s.boarding_allowed, drop: s.dropping_allowed })),
        newValues: stops.map(s => ({ id: s.id, stop: s.stop_name, order: s.stop_order, arr: s.arrival_time, dep: s.departure_time, board: s.boarding_allowed, drop: s.dropping_allowed })),
      }, conn);
      return { removed, deactivated };
    });

    const msg = result.deactivated
      ? `Stops saved. ${result.deactivated} stop(s) used by bookings were deactivated instead of deleted.`
      : 'Stops saved';
    return success(res, { ...result, stops: await getRouteStops(routeId, { activeOnly: false }) }, msg);
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------
// PUT /api/admin/routes/:id/fares  { fares: [{ from_stop_id, to_stop_id, fare }] }
// fare = null/'' removes the segment fare.
// ---------------------------------------------------------------
router.put('/:id/fares', requirePermission('fares.manage'), validate([
  id,
  body('fares').isArray({ min: 1, max: 500 }).withMessage('No fares supplied'),
  body('fares.*.from_stop_id').isInt({ min: 1 }).toInt(),
  body('fares.*.to_stop_id').isInt({ min: 1 }).toInt(),
  body('fares.*.fare').optional({ values: 'null' })
    .custom(v => v === '' || (Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= 100000))
    .withMessage('Fare must be a number between 0 and 100000 (fares cannot be negative)'),
]), async (req, res, next) => {
  try {
    const routeId = req.params.id;
    const stops = await getRouteStops(routeId);
    if (!stops.length) return error(res, 'Route not found or has no active stops', 404);
    const byId = new Map(stops.map(s => [s.id, s]));

    const changes = await withTransaction(async (conn) => {
      const [existingRows] = await conn.query('SELECT * FROM route_fares WHERE route_id = ? FOR UPDATE', [routeId]);
      const existing = new Map(existingRows.map(f => [`${f.from_stop_id}-${f.to_stop_id}`, f]));
      const oldV = []; const newV = [];

      for (const f of req.body.fares) {
        const a = byId.get(f.from_stop_id); const b = byId.get(f.to_stop_id);
        if (!a || !b) throw httpError(400, 'Fare refers to a stop that is not active on this route');
        if (a.stop_order >= b.stop_order) throw httpError(400, `${a.stop_name} → ${b.stop_name}: boarding must be before dropping`);
        const key = `${a.id}-${b.id}`;
        const prev = existing.get(key);
        const remove = f.fare === null || f.fare === '' || f.fare === undefined;

        if (remove) {
          if (prev) {
            await conn.query('DELETE FROM route_fares WHERE id = ?', [prev.id]);
            oldV.push({ segment: `${a.stop_name} → ${b.stop_name}`, fare: prev.fare }); newV.push({ segment: `${a.stop_name} → ${b.stop_name}`, fare: null });
          }
          continue;
        }
        if (!a.boarding_allowed) throw httpError(400, `Boarding is not allowed at ${a.stop_name}`);
        if (!b.dropping_allowed) throw httpError(400, `Dropping is not allowed at ${b.stop_name}`);
        const fare = Math.round(Number(f.fare) * 100) / 100;
        if (prev && Number(prev.fare) === fare && prev.is_active) continue;
        await conn.query(
          `INSERT INTO route_fares (route_id, from_stop_id, to_stop_id, fare, is_active) VALUES (?, ?, ?, ?, 1)
           ON DUPLICATE KEY UPDATE fare = VALUES(fare), is_active = 1`,
          [routeId, a.id, b.id, fare]
        );
        oldV.push({ segment: `${a.stop_name} → ${b.stop_name}`, fare: prev ? prev.fare : null });
        newV.push({ segment: `${a.stop_name} → ${b.stop_name}`, fare });
      }
      if (newV.length) {
        await audit(req, { action: 'route.fares.update', module: 'fares', recordId: Number(routeId), oldValues: oldV, newValues: newV }, conn);
      }
      return newV.length;
    });
    const [fares] = await pool.query('SELECT id, from_stop_id, to_stop_id, fare, is_active FROM route_fares WHERE route_id = ?', [routeId]);
    return success(res, { changes, fares }, changes ? `${changes} fare(s) updated` : 'No changes');
  } catch (err) { next(err); }
});

module.exports = router;
module.exports.handlers = {
  create: [validate(routeFields()), create],
  update: [validate([id, ...routeFields(true)]), update],
  remove: [validate([id]), remove],
};
