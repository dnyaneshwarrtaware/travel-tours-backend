/**
 * Per-trip seat state.
 *
 * A seat with no trip_seats row is AVAILABLE. Rows carry LOCKED (temporary hold
 * while the customer completes booking), BOOKED (held by a booking) or BLOCKED
 * (admin). The UNIQUE(trip_id, seat_id) key makes double booking impossible,
 * and every write path locks the trip row first (SELECT ... FOR UPDATE) so
 * concurrent requests for the same trip are serialised.
 */
const { v4: uuidv4, validate: isUuid } = require('uuid');
const { pool, withTransaction } = require('../config/database');
const httpError = require('../utils/httpError');
const { getTripCore, assertTripBookable } = require('./trip.service');

const LOCK_MINUTES = () => parseInt(process.env.SEAT_LOCK_MINUTES) || 10;
const MAX_SEATS = () => parseInt(process.env.MAX_SEATS_PER_BOOKING) || 6;

const clearExpiredLocks = (conn, tripId) =>
  conn.query("DELETE FROM trip_seats WHERE trip_id = ? AND status = 'LOCKED' AND locked_until <= NOW()", [tripId]);

const getLayoutSeats = async (layoutId, conn = pool) => {
  const [rows] = await conn.query(
    `SELECT id, seat_number, deck, row_no, col_no, seat_type, is_active
     FROM seat_layout_seats WHERE seat_layout_id = ? ORDER BY deck, row_no, col_no`,
    [layoutId]
  );
  return rows;
};

// Seat map for a trip. `lockToken` marks the caller's own locks as "selected".
const getSeatMap = async (tripId, lockToken = null, { includeBookingRefs = false } = {}) => {
  const trip = await getTripCore(tripId);
  if (!trip.seat_layout_id) throw httpError(400, 'This vehicle has no seat layout configured');

  const [[layout]] = await pool.query('SELECT id, name, seat_type, decks, rows_count, cols_count, aisle_after_col FROM seat_layouts WHERE id = ?', [trip.seat_layout_id]);
  const seats = await getLayoutSeats(trip.seat_layout_id);
  const [states] = await pool.query(
    `SELECT ts.seat_id, ts.status, ts.lock_token, ts.locked_until, ts.booking_id, b.booking_number
     FROM trip_seats ts LEFT JOIN bookings b ON b.id = ts.booking_id
     WHERE ts.trip_id = ? AND (ts.status <> 'LOCKED' OR ts.locked_until > NOW())`,
    [tripId]
  );
  const stateBySeat = new Map(states.map(s => [s.seat_id, s]));

  let lockedUntil = null;
  const out = seats.map(seat => {
    const st = stateBySeat.get(seat.id);
    let status = 'AVAILABLE';
    let mine = false;
    if (!seat.is_active) status = 'BLOCKED';
    else if (st) {
      status = st.status;
      if (st.status === 'LOCKED' && lockToken && st.lock_token === lockToken) {
        mine = true;
        lockedUntil = st.locked_until;
      }
    }
    const item = { id: seat.id, seat_number: seat.seat_number, deck: seat.deck, row_no: seat.row_no, col_no: seat.col_no, seat_type: seat.seat_type, status, mine };
    if (includeBookingRefs && st) {
      item.booking_id = st.booking_id;
      item.booking_number = st.booking_number;
      item.admin_blocked = st.status === 'BLOCKED';
    }
    return item;
  });

  return { trip_id: trip.id, layout, seats: out, locked_until: lockedUntil, lock_minutes: LOCK_MINUTES(), max_seats: MAX_SEATS() };
};

const assertSeatIds = (seatIds) => {
  if (!Array.isArray(seatIds) || !seatIds.length) throw httpError(400, 'Select at least one seat');
  const ids = seatIds.map(Number);
  if (ids.some(id => !Number.isInteger(id) || id <= 0)) throw httpError(400, 'Invalid seat selection');
  if (new Set(ids).size !== ids.length) throw httpError(400, 'Duplicate seats in selection');
  if (ids.length > MAX_SEATS()) throw httpError(400, `You can book at most ${MAX_SEATS()} seats at a time`);
  return ids;
};

/**
 * Inside an open transaction (trip row already locked): verifies every seat can
 * be taken by `lockToken` and returns the seat rows. Throws 409 listing seats
 * that are no longer available.
 */
const checkSeatsAvailable = async (conn, trip, seatIds, lockToken) => {
  await clearExpiredLocks(conn, trip.id);
  const [seats] = await conn.query(
    'SELECT id, seat_number, is_active FROM seat_layout_seats WHERE seat_layout_id = ? AND id IN (?)',
    [trip.seat_layout_id, seatIds]
  );
  if (seats.length !== seatIds.length) throw httpError(400, 'One or more seats do not belong to this vehicle');
  const inactive = seats.filter(s => !s.is_active);
  if (inactive.length) throw httpError(409, `Seat ${inactive.map(s => s.seat_number).join(', ')} is not available`, { unavailable_seat_ids: inactive.map(s => s.id) });

  const [taken] = await conn.query(
    'SELECT seat_id, status, lock_token FROM trip_seats WHERE trip_id = ? AND seat_id IN (?) FOR UPDATE',
    [trip.id, seatIds]
  );
  const conflicts = taken.filter(t => !(t.status === 'LOCKED' && lockToken && t.lock_token === lockToken));
  if (conflicts.length) {
    const ids = conflicts.map(c => c.seat_id);
    const names = seats.filter(s => ids.includes(s.id)).map(s => s.seat_number);
    throw httpError(409, `Sorry, seat ${names.join(', ')} ${names.length > 1 ? 'were' : 'was'} just taken. Please choose another seat.`, { unavailable_seat_ids: ids });
  }
  return seats;
};

// Lock seats for `lockToken` (new token issued if none). Replaces the token's previous locks on this trip.
const lockSeats = async (tripId, seatIdsInput, lockTokenInput) => {
  const seatIds = assertSeatIds(seatIdsInput);
  const lockToken = lockTokenInput && isUuid(lockTokenInput) ? lockTokenInput : uuidv4();

  return withTransaction(async (conn) => {
    const trip = await getTripCore(tripId, { conn, forUpdate: true });
    assertTripBookable(trip);
    await checkSeatsAvailable(conn, trip, seatIds, lockToken);

    await conn.query(
      "DELETE FROM trip_seats WHERE trip_id = ? AND status = 'LOCKED' AND lock_token = ? AND seat_id NOT IN (?)",
      [trip.id, lockToken, seatIds]
    );
    const minutes = LOCK_MINUTES();
    for (const seatId of seatIds) {
      await conn.query(
        `INSERT INTO trip_seats (trip_id, seat_id, status, lock_token, locked_until)
         VALUES (?, ?, 'LOCKED', ?, DATE_ADD(NOW(), INTERVAL ? MINUTE))
         ON DUPLICATE KEY UPDATE locked_until = VALUES(locked_until)`,
        [trip.id, seatId, lockToken, minutes]
      );
    }
    const [[{ until }]] = await conn.query('SELECT DATE_ADD(NOW(), INTERVAL ? MINUTE) AS until', [minutes]);
    return { lock_token: lockToken, seat_ids: seatIds, locked_until: until, lock_minutes: minutes };
  });
};

const releaseLocks = async (tripId, lockToken) => {
  if (!lockToken || !isUuid(lockToken)) return 0;
  const [r] = await pool.query("DELETE FROM trip_seats WHERE trip_id = ? AND status = 'LOCKED' AND lock_token = ?", [tripId, lockToken]);
  return r.affectedRows;
};

// Admin: block / unblock seats on a single trip
const setSeatsBlocked = async (tripId, seatIdsInput, blocked) => {
  const seatIds = (seatIdsInput || []).map(Number).filter(n => Number.isInteger(n) && n > 0);
  if (!seatIds.length) throw httpError(400, 'Select at least one seat');
  return withTransaction(async (conn) => {
    const trip = await getTripCore(tripId, { conn, forUpdate: true });
    if (blocked) {
      await checkSeatsAvailable(conn, trip, seatIds, null);
      for (const seatId of seatIds) {
        await conn.query("INSERT INTO trip_seats (trip_id, seat_id, status) VALUES (?, ?, 'BLOCKED')", [trip.id, seatId]);
      }
    } else {
      await conn.query("DELETE FROM trip_seats WHERE trip_id = ? AND status = 'BLOCKED' AND seat_id IN (?)", [trip.id, seatIds]);
    }
    return { trip_id: trip.id, seat_ids: seatIds, blocked };
  });
};

module.exports = { getSeatMap, lockSeats, releaseLocks, setSeatsBlocked, checkSeatsAvailable, assertSeatIds, getLayoutSeats, clearExpiredLocks, MAX_SEATS };
