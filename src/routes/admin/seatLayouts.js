const router = require('express').Router();
const { body, param } = require('express-validator');
const validate = require('../../middleware/validate');
const { pool, withTransaction } = require('../../config/database');
const { success, error } = require('../../utils/response');
const httpError = require('../../utils/httpError');
const { toFlag } = require('../../utils/admin');
const { audit } = require('../../services/audit.service');

/**
 * Builds the seat grid. Seaters are numbered 01..N row by row; sleepers are
 * numbered per deck (L01.., U01..). `aisle_after_col` is only used for display.
 */
const generateSeats = ({ seat_type, decks, rows_count, cols_count }) => {
  const seats = [];
  const deckNames = decks === 2 ? ['lower', 'upper'] : ['lower'];
  deckNames.forEach(deck => {
    let n = 0;
    for (let r = 1; r <= rows_count; r++) {
      for (let c = 1; c <= cols_count; c++) {
        n++;
        const num = String(n).padStart(2, '0');
        const seat_number = seat_type === 'sleeper' ? `${deck === 'lower' ? 'L' : 'U'}${num}` : (decks === 2 ? `${deck === 'lower' ? 'L' : 'U'}${num}` : num);
        seats.push({ seat_number, deck, row_no: r, col_no: c, seat_type });
      }
    }
  });
  return seats;
};

const gridFields = [
  body('seat_type').isIn(['seater', 'sleeper']).withMessage('Select seater or sleeper'),
  body('decks').isInt({ min: 1, max: 2 }).withMessage('Decks must be 1 or 2').toInt(),
  body('rows_count').isInt({ min: 1, max: 20 }).withMessage('Rows must be between 1 and 20').toInt(),
  body('cols_count').isInt({ min: 2, max: 5 }).withMessage('Seats per row must be between 2 and 5').toInt(),
  body('aisle_after_col').isInt({ min: 1, max: 4 }).toInt()
    .custom((v, { req }) => v < Number(req.body.cols_count)).withMessage('Aisle position must be inside the row'),
];

router.get('/', async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT sl.*,
              (SELECT COUNT(*) FROM seat_layout_seats s WHERE s.seat_layout_id = sl.id AND s.is_active = 1) AS active_seats,
              (SELECT COUNT(*) FROM vehicles v WHERE v.seat_layout_id = sl.id AND v.deleted_at IS NULL) AS vehicle_count
       FROM seat_layouts sl ORDER BY sl.is_active DESC, sl.name`
    );
    return success(res, rows);
  } catch (err) { next(err); }
});

router.get('/:id', validate([param('id').isInt()]), async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT * FROM seat_layouts WHERE id = ?', [req.params.id]);
    if (!rows.length) return error(res, 'Seat layout not found', 404);
    const [seats] = await pool.query(
      'SELECT id, seat_number, deck, row_no, col_no, seat_type, is_active FROM seat_layout_seats WHERE seat_layout_id = ? ORDER BY deck, row_no, col_no',
      [req.params.id]
    );
    return success(res, { ...rows[0], seats });
  } catch (err) { next(err); }
});

router.post('/', validate([
  body('name').trim().isLength({ min: 2, max: 150 }).withMessage('Layout name is required'),
  ...gridFields,
]), async (req, res, next) => {
  try {
    const grid = { seat_type: req.body.seat_type, decks: req.body.decks, rows_count: req.body.rows_count, cols_count: req.body.cols_count, aisle_after_col: req.body.aisle_after_col };
    const seats = generateSeats(grid);
    const id = await withTransaction(async (conn) => {
      const [r] = await conn.query('INSERT INTO seat_layouts SET ?', [{ name: req.body.name, description: req.body.description || null, ...grid, total_seats: seats.length }]);
      await conn.query(
        'INSERT INTO seat_layout_seats (seat_layout_id, seat_number, deck, row_no, col_no, seat_type) VALUES ?',
        [seats.map(s => [r.insertId, s.seat_number, s.deck, s.row_no, s.col_no, s.seat_type])]
      );
      await audit(req, { action: 'seat_layout.create', module: 'seat_layouts', recordId: r.insertId, newValues: { name: req.body.name, ...grid, total_seats: seats.length } }, conn);
      return r.insertId;
    });
    return success(res, { id, total_seats: seats.length }, 'Seat layout created', 201);
  } catch (err) { next(err); }
});

// PUT /api/admin/seat-layouts/:id - rename / describe / (de)activate; regenerate grid only if unused
router.put('/:id', validate([
  param('id').isInt().toInt(),
  body('name').optional().trim().isLength({ min: 2, max: 150 }),
  body('regenerate').optional().isBoolean(),
]), async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT * FROM seat_layouts WHERE id = ?', [req.params.id]);
    if (!rows.length) return error(res, 'Seat layout not found', 404);
    const layout = rows[0];

    await withTransaction(async (conn) => {
      const data = {};
      if (req.body.name !== undefined) data.name = req.body.name;
      if (req.body.description !== undefined) data.description = req.body.description || null;
      if (req.body.is_active !== undefined) data.is_active = toFlag(req.body.is_active);

      if (req.body.regenerate) {
        const [[{ used }]] = await conn.query(
          `SELECT (SELECT COUNT(*) FROM booking_passengers bp JOIN seat_layout_seats s ON s.id = bp.seat_id WHERE s.seat_layout_id = ?)
                + (SELECT COUNT(*) FROM trip_seats ts JOIN seat_layout_seats s ON s.id = ts.seat_id WHERE s.seat_layout_id = ?) AS used`,
          [layout.id, layout.id]
        );
        if (used > 0) throw httpError(400, 'This layout already has bookings, so its seat grid cannot be regenerated. Create a new layout instead.');
        const grid = {
          seat_type: req.body.seat_type, decks: Number(req.body.decks), rows_count: Number(req.body.rows_count),
          cols_count: Number(req.body.cols_count), aisle_after_col: Number(req.body.aisle_after_col),
        };
        const validGrid = ['seater', 'sleeper'].includes(grid.seat_type) && [1, 2].includes(grid.decks)
          && grid.rows_count >= 1 && grid.rows_count <= 20 && grid.cols_count >= 2 && grid.cols_count <= 5
          && grid.aisle_after_col >= 1 && grid.aisle_after_col < grid.cols_count;
        if (!validGrid) throw httpError(422, 'Invalid seat grid: rows 1-20, seats per row 2-5, aisle inside the row');
        const seats = generateSeats(grid);
        await conn.query('DELETE FROM seat_layout_seats WHERE seat_layout_id = ?', [layout.id]);
        await conn.query(
          'INSERT INTO seat_layout_seats (seat_layout_id, seat_number, deck, row_no, col_no, seat_type) VALUES ?',
          [seats.map(s => [layout.id, s.seat_number, s.deck, s.row_no, s.col_no, s.seat_type])]
        );
        Object.assign(data, grid, { total_seats: seats.length });
        await conn.query('UPDATE vehicles SET capacity = ?, seat_type = ? WHERE seat_layout_id = ?', [seats.length, grid.seat_type, layout.id]);
      }
      if (Object.keys(data).length) {
        await conn.query('UPDATE seat_layouts SET ? WHERE id = ?', [data, layout.id]);
        await audit(req, { action: 'seat_layout.update', module: 'seat_layouts', recordId: layout.id, oldValues: { name: layout.name, rows: layout.rows_count, cols: layout.cols_count, total: layout.total_seats, active: layout.is_active }, newValues: data }, conn);
      }
    });
    return success(res, null, 'Seat layout updated');
  } catch (err) { next(err); }
});

// PATCH /api/admin/seat-layouts/:id/seats/:seatId { is_active } - take a seat out of service (all trips)
router.patch('/:id/seats/:seatId', validate([param('id').isInt(), param('seatId').isInt(), body('is_active').isBoolean()]), async (req, res, next) => {
  try {
    const isActive = toFlag(req.body.is_active);
    const [r] = await pool.query('UPDATE seat_layout_seats SET is_active = ? WHERE id = ? AND seat_layout_id = ?', [isActive, req.params.seatId, req.params.id]);
    if (!r.affectedRows) return error(res, 'Seat not found', 404);
    const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM seat_layout_seats WHERE seat_layout_id = ? AND is_active = 1', [req.params.id]);
    await pool.query('UPDATE vehicles SET capacity = ? WHERE seat_layout_id = ?', [n, req.params.id]);
    await audit(req, { action: isActive ? 'seat.enable' : 'seat.disable', module: 'seat_layouts', recordId: Number(req.params.id), newValues: { seat_id: Number(req.params.seatId), is_active: isActive } });
    return success(res, { active_seats: n }, isActive ? 'Seat enabled' : 'Seat disabled');
  } catch (err) { next(err); }
});

module.exports = router;
module.exports.generateSeats = generateSeats;
