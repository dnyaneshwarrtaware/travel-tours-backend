const { v4: uuidv4 } = require('uuid');
const { pool, withTransaction } = require('../config/database');
const httpError = require('../utils/httpError');
const { tripStopSchedule, nowIST, todayIST } = require('../utils/time');
const { getTripCore, getRouteStops, assertTripBookable, resolveSegment } = require('./trip.service');
const { checkSeatsAvailable, assertSeatIds } = require('./seat.service');
const { assertMethodAvailable } = require('./payments/payment.service');
const { getProvider } = require('./payments/providers');
const { audit } = require('./audit.service');
const { notify } = require('./notification.service');

const PHONE_RE = /^[6-9]\d{9}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const cleanPhone = (p) => String(p || '').replace(/[\s-]/g, '').replace(/^(\+91|91)(?=\d{10}$)/, '');

const formatBookingNumber = (id, date = new Date()) => `GT${date.getFullYear()}${100000 + id}`;

// Validates and normalises customer-supplied booking input (fare/status are never taken from input)
const normaliseInput = (input) => {
  const contact = input.contact || {};
  const c = {
    name: String(contact.name || '').trim(),
    phone: cleanPhone(contact.phone),
    email: String(contact.email || '').trim().toLowerCase() || null,
  };
  if (c.name.length < 2 || c.name.length > 150) throw httpError(422, 'Please enter the contact name');
  if (!PHONE_RE.test(c.phone)) throw httpError(422, 'Please enter a valid 10-digit mobile number');
  if (c.email && !EMAIL_RE.test(c.email)) throw httpError(422, 'Please enter a valid email address');

  if (!Array.isArray(input.passengers) || !input.passengers.length) throw httpError(422, 'Add at least one passenger');
  const passengers = input.passengers.map((p, i) => {
    const name = String(p.name || '').trim();
    const age = Number(p.age);
    const gender = String(p.gender || '').toLowerCase();
    const mobile = p.mobile ? cleanPhone(p.mobile) : null;
    if (name.length < 2 || name.length > 150) throw httpError(422, `Passenger ${i + 1}: please enter a name`);
    if (!Number.isInteger(age) || age < 1 || age > 120) throw httpError(422, `Passenger ${i + 1}: please enter a valid age`);
    if (!['male', 'female', 'other'].includes(gender)) throw httpError(422, `Passenger ${i + 1}: please select gender`);
    if (mobile && !PHONE_RE.test(mobile)) throw httpError(422, `Passenger ${i + 1}: invalid mobile number`);
    return { name, age, gender, mobile, seat_id: Number(p.seat_id) };
  });

  const upiRef = input.upi_reference ? String(input.upi_reference).trim().slice(0, 100) : null;
  return { contact: c, passengers, upiRef };
};

const findOrCreateGuest = async (conn, contact) => {
  const [rows] = await conn.query(
    'SELECT id FROM customers WHERE phone = ? AND password_hash IS NULL AND email <=> ? ORDER BY id DESC LIMIT 1',
    [contact.phone, contact.email]
  );
  if (rows.length) {
    await conn.query('UPDATE customers SET name = ? WHERE id = ?', [contact.name, rows[0].id]);
    return rows[0].id;
  }
  const [r] = await conn.query('INSERT INTO customers (name, email, phone) VALUES (?, ?, ?)', [contact.name, contact.email, contact.phone]);
  return r.insertId;
};

/**
 * Booking detail. `where` is { id } or { booking_number }.
 */
const getBookingDetail = async (where, conn = pool) => {
  const [rows] = await conn.query(
    `SELECT b.*, t.travel_date, t.departure_time, t.arrival_time, t.status AS trip_status, t.route_id, t.vehicle_id,
            t.fare_adjustment_pct,
            r.name AS route_name, fl.city AS from_city, tl.city AS to_city,
            v.name AS vehicle_name, v.registration_number, v.is_ac, v.seat_type,
            bs.stop_name AS boarding_stop_name, ds.stop_name AS dropping_stop_name,
            c.name AS customer_name, c.email AS customer_email, c.phone AS customer_phone
     FROM bookings b
     JOIN trips t ON t.id = b.trip_id
     JOIN routes r ON r.id = t.route_id
     JOIN locations fl ON fl.id = r.from_location_id
     JOIN locations tl ON tl.id = r.to_location_id
     JOIN vehicles v ON v.id = t.vehicle_id
     JOIN route_stops bs ON bs.id = b.boarding_stop_id
     JOIN route_stops ds ON ds.id = b.dropping_stop_id
     LEFT JOIN customers c ON c.id = b.customer_id
     WHERE ${where.id ? 'b.id = ?' : 'b.booking_number = ?'}`,
    [where.id || where.booking_number]
  );
  if (!rows.length) throw httpError(404, 'Booking not found');
  const b = rows[0];

  const [passengers] = await conn.query(
    `SELECT bp.id, bp.name, bp.age, bp.gender, bp.mobile, bp.seat_id, bp.fare, s.seat_number, s.deck
     FROM booking_passengers bp JOIN seat_layout_seats s ON s.id = bp.seat_id
     WHERE bp.booking_id = ? ORDER BY bp.id`,
    [b.id]
  );
  const [payments] = await conn.query(
    `SELECT p.*, u.name AS verified_by_name FROM payments p LEFT JOIN users u ON u.id = p.verified_by
     WHERE p.booking_id = ? ORDER BY p.id DESC`,
    [b.id]
  );

  // Boarding/dropping times for this trip
  const stops = tripStopSchedule(b, await getRouteStops(b.route_id, { activeOnly: false, conn }));
  const bStop = stops.find(s => s.id === b.boarding_stop_id);
  const dStop = stops.find(s => s.id === b.dropping_stop_id);

  return {
    ...b,
    route_label: b.route_name || `${b.from_city} → ${b.to_city}`,
    boarding_at: bStop?.departure_at || `${b.travel_date} ${b.departure_time}`,
    dropping_at: dStop?.arrival_at || null,
    passengers,
    payment: payments[0] || null,
    payments,
  };
};

// Public view of a booking (no internal ids/notes beyond what the customer needs)
const publicBooking = (b) => ({
  booking_number: b.booking_number,
  booking_status: b.booking_status,
  payment_status: b.payment_status,
  payment_method: b.payment_method,
  route_label: b.route_label,
  from_city: b.from_city,
  to_city: b.to_city,
  travel_date: b.travel_date,
  departure_time: b.departure_time,
  boarding_stop_name: b.boarding_stop_name,
  dropping_stop_name: b.dropping_stop_name,
  boarding_at: b.boarding_at,
  dropping_at: b.dropping_at,
  vehicle_name: b.vehicle_name,
  registration_number: b.registration_number,
  is_ac: !!b.is_ac,
  seat_type: b.seat_type,
  contact_name: b.contact_name,
  contact_phone: b.contact_phone,
  contact_email: b.contact_email,
  seat_count: b.seat_count,
  fare_per_seat: b.fare_per_seat,
  total_amount: b.total_amount,
  created_at: b.created_at,
  cancelled_at: b.cancelled_at,
  cancellation_reason: b.cancellation_reason,
  trip_status: b.trip_status,
  passengers: b.passengers.map(p => ({ name: p.name, age: p.age, gender: p.gender, seat_number: p.seat_number, fare: p.fare })),
  payment: b.payment ? {
    payment_method: b.payment.payment_method,
    payment_status: b.payment.payment_status,
    amount: b.payment.amount,
    upi_reference: b.payment.upi_reference,
  } : null,
});

/**
 * Create a booking. All prices and statuses are decided here, never by the client.
 * ctx: { req, source: 'website'|'admin', customerId?, adminId? }
 */
const createBooking = async (input, ctx) => {
  const { contact, passengers, upiRef } = normaliseInput(input);
  const seatIds = assertSeatIds(passengers.map(p => p.seat_id));
  const method = String(input.payment_method || '').toUpperCase();
  const isAdmin = ctx.source === 'admin';
  const markPaidNow = isAdmin && !!input.mark_paid_now;

  const bookingId = await withTransaction(async (conn) => {
    const trip = await getTripCore(input.trip_id, { conn, forUpdate: true });
    assertTripBookable(trip);

    const schedule = tripStopSchedule(trip, await getRouteStops(trip.route_id, { conn }));
    const segment = await resolveSegment(trip, input.boarding_stop_id, input.dropping_stop_id, { conn, schedule });

    await checkSeatsAvailable(conn, trip, seatIds, input.lock_token || null);

    const provider = isAdmin ? getProvider(method) : await assertMethodAvailable(conn, method);
    if (!provider) throw httpError(400, 'Please select a valid payment method');
    if (method === 'UPI_QR' && !isAdmin) {
      const [[qr]] = await conn.query("SELECT qr_image FROM payment_settings WHERE payment_method = 'UPI_QR'");
      if (!qr?.qr_image) throw httpError(400, 'UPI QR payment is not configured yet');
    }
    const init = provider.initiate({ markPaidNow });

    const customerId = ctx.customerId || await findOrCreateGuest(conn, contact);
    const farePerSeat = segment.fare_per_seat;
    const total = farePerSeat * passengers.length;

    const [ins] = await conn.query(
      `INSERT INTO bookings (booking_number, customer_id, trip_id, boarding_stop_id, dropping_stop_id,
        contact_name, contact_phone, contact_email, seat_count, fare_per_seat, total_amount,
        payment_method, booking_status, payment_status, source, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      // Unique placeholder; replaced with GT<year><100000+id> right after the insert
      [`TMP${uuidv4().replace(/-/g, '').slice(0, 27)}`, customerId, trip.id, segment.boarding.id, segment.dropping.id,
        contact.name, contact.phone, contact.email, passengers.length, farePerSeat, total,
        method, init.booking_status, init.payment_status, isAdmin ? 'admin' : 'website', isAdmin ? ctx.adminId : null]
    );
    const id = ins.insertId;
    const bookingNumber = formatBookingNumber(id);
    await conn.query('UPDATE bookings SET booking_number = ? WHERE id = ?', [bookingNumber, id]);

    for (const p of passengers) {
      await conn.query(
        'INSERT INTO booking_passengers (booking_id, name, age, gender, mobile, seat_id, fare) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [id, p.name, p.age, p.gender, p.mobile, p.seat_id, farePerSeat]
      );
      await conn.query(
        `INSERT INTO trip_seats (trip_id, seat_id, status, booking_id) VALUES (?, ?, 'BOOKED', ?)
         ON DUPLICATE KEY UPDATE status = 'BOOKED', booking_id = VALUES(booking_id), lock_token = NULL, locked_until = NULL`,
        [trip.id, p.seat_id, id]
      );
    }
    // Release any other seats this session had locked on the trip
    if (input.lock_token) {
      await conn.query("DELETE FROM trip_seats WHERE trip_id = ? AND status = 'LOCKED' AND lock_token = ?", [trip.id, input.lock_token]);
    }

    await conn.query(
      `INSERT INTO payments (booking_id, payment_method, payment_status, amount, upi_reference, transaction_reference,
         payment_date, verified_by, verified_at, remarks)
       VALUES (?, ?, ?, ?, ?, ?, ${init.payment_date ? 'NOW()' : 'NULL'}, ?, ${markPaidNow ? 'NOW()' : 'NULL'}, ?)`,
      [id, method, init.payment_status, total, method === 'UPI_QR' ? upiRef : null,
        isAdmin && input.transaction_reference ? String(input.transaction_reference).slice(0, 100) : null,
        markPaidNow ? ctx.adminId : null, isAdmin && input.remarks ? String(input.remarks).slice(0, 1000) : null]
    );

    await audit(ctx.req, {
      action: 'booking.create', module: 'bookings', recordId: id,
      newValues: { booking_number: bookingNumber, trip_id: trip.id, seats: passengers.length, total_amount: total, payment_method: method, booking_status: init.booking_status, payment_status: init.payment_status, source: isAdmin ? 'admin' : 'website' },
      userType: isAdmin ? 'admin' : (ctx.customerId ? 'customer' : 'system'),
    }, conn);

    const route = `${segment.boarding.stop_name} → ${segment.dropping.stop_name}`;
    if (init.payment_status === 'verification_pending') {
      await notify(conn, { type: 'payment_verification', title: `UPI payment to verify: ${bookingNumber}`, message: `${contact.name} · ${route} · ₹${total}`, link: '/admin/payments?status=verification_pending' });
    } else if (!isAdmin) {
      await notify(conn, { type: 'new_booking', title: `New ${method === 'CASH' ? 'cash' : ''} booking ${bookingNumber}`.replace('  ', ' '), message: `${contact.name} · ${route} · ₹${total}`, link: '/admin/bookings' });
    }
    return id;
  });

  return getBookingDetail({ id: bookingId });
};

const CANCELLABLE = ['pending', 'reserved', 'confirmed'];

/**
 * Cancel a booking and release its seats.
 * actor: { type: 'admin'|'customer', reason }
 */
const cancelBooking = async (bookingId, actor, req) => {
  await withTransaction(async (conn) => {
    const [rows] = await conn.query('SELECT * FROM bookings WHERE id = ? FOR UPDATE', [bookingId]);
    if (!rows.length) throw httpError(404, 'Booking not found');
    const b = rows[0];
    if (!CANCELLABLE.includes(b.booking_status)) throw httpError(400, `A ${b.booking_status.replace('_', ' ')} booking cannot be cancelled`);

    const detail = await getBookingDetail({ id: b.id }, conn);
    if (actor.type === 'customer' && detail.boarding_at <= nowIST()) {
      throw httpError(400, 'This booking can no longer be cancelled online because the bus has departed. Please contact support.');
    }

    // Money received (or claimed) must be refunded; otherwise nothing is owed
    const newPaymentStatus = ['paid', 'verification_pending'].includes(b.payment_status) ? 'refund_pending' : 'not_applicable';

    await conn.query('DELETE FROM trip_seats WHERE booking_id = ?', [b.id]);
    await conn.query(
      `UPDATE bookings SET booking_status = 'cancelled', payment_status = ?, cancelled_at = NOW(),
         cancelled_by_type = ?, cancelled_by = ?, cancellation_reason = ? WHERE id = ?`,
      [newPaymentStatus, actor.type, req?.user?.id || null, (actor.reason || '').slice(0, 500) || null, b.id]
    );
    await conn.query(
      `UPDATE payments SET payment_status = ?, remarks = CONCAT_WS(' | ', remarks, ?) WHERE booking_id = ? AND payment_status NOT IN ('refunded')`,
      [newPaymentStatus, newPaymentStatus === 'refund_pending' ? 'Booking cancelled - refund due (verify receipt before refunding)' : 'Booking cancelled', b.id]
    );

    await audit(req, {
      action: 'booking.cancel', module: 'bookings', recordId: b.id,
      oldValues: { booking_number: b.booking_number, booking_status: b.booking_status, payment_status: b.payment_status },
      newValues: { booking_status: 'cancelled', payment_status: newPaymentStatus, reason: actor.reason || null, cancelled_by: actor.type },
      userType: actor.type === 'admin' ? 'admin' : 'customer',
    }, conn);

    if (actor.type === 'customer') {
      await notify(conn, { type: 'booking_cancelled', title: `Booking ${b.booking_number} cancelled by customer`, message: newPaymentStatus === 'refund_pending' ? 'Refund pending' : null, link: '/admin/cancellations' });
    }
  });
  return getBookingDetail({ id: bookingId });
};

// Admin: post-trip status changes
const STATUS_TRANSITIONS = {
  completed: ['confirmed'],
  no_show: ['confirmed', 'reserved', 'pending'],
};

const updateBookingStatus = async (bookingId, status, req) => {
  if (!STATUS_TRANSITIONS[status]) throw httpError(400, 'Invalid status. Use cancel to cancel a booking.');
  await withTransaction(async (conn) => {
    const [rows] = await conn.query(
      'SELECT b.*, t.travel_date FROM bookings b JOIN trips t ON t.id = b.trip_id WHERE b.id = ? FOR UPDATE', [bookingId]
    );
    if (!rows.length) throw httpError(404, 'Booking not found');
    const b = rows[0];
    if (!STATUS_TRANSITIONS[status].includes(b.booking_status)) {
      throw httpError(400, `Cannot change a ${b.booking_status.replace('_', ' ')} booking to ${status.replace('_', ' ')}`);
    }
    if (b.travel_date > todayIST()) throw httpError(400, 'The journey date has not arrived yet');

    const paymentStatus = status === 'no_show' && b.payment_status !== 'paid' ? 'not_applicable' : b.payment_status;
    if (status === 'no_show') await conn.query('DELETE FROM trip_seats WHERE booking_id = ?', [b.id]);
    await conn.query('UPDATE bookings SET booking_status = ?, payment_status = ? WHERE id = ?', [status, paymentStatus, b.id]);
    if (paymentStatus !== b.payment_status) {
      await conn.query("UPDATE payments SET payment_status = ? WHERE booking_id = ? AND payment_status IN ('pending','verification_pending','failed')", [paymentStatus, b.id]);
    }
    await audit(req, {
      action: `booking.${status}`, module: 'bookings', recordId: b.id,
      oldValues: { booking_status: b.booking_status, payment_status: b.payment_status },
      newValues: { booking_status: status, payment_status: paymentStatus },
    }, conn);
  });
  return getBookingDetail({ id: bookingId });
};

module.exports = {
  createBooking, getBookingDetail, publicBooking, cancelBooking, updateBookingStatus,
  cleanPhone, formatBookingNumber, PHONE_RE, EMAIL_RE,
};
