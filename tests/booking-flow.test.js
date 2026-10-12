/**
 * End-to-end API tests for the Phase-1 booking + payment workflow.
 *
 *   npm test
 *
 * Uses a separate database (TEST_DB_NAME, default travel_tours_test) that is
 * dropped, migrated and seeded fresh on every run. The demo database is untouched.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

require('dotenv').config({ path: path.join(__dirname, '../.env') });
const TEST_DB = process.env.TEST_DB_NAME || 'travel_tours_test';
process.env.DB_NAME = TEST_DB;
process.env.NODE_ENV = 'test';
process.env.RATE_LIMIT_MAX = '100000';
process.env.SEED_ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL || 'admin@ganrajtraveling.demo';
process.env.SEED_ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD || 'Ganraj@Test2026';

let server; let base; let pool; let adminToken; let today; let day;

const api = async (method, url, { body, token, form } = {}) => {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${base}${url}`, { method, headers, body: form || (body ? JSON.stringify(body) : undefined) });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, ...json };
};

const login = async (email, password) => (await api('POST', '/api/auth/admin/login', { body: { email, password } })).data?.token;

const searchTrip = async (from, to, date, dep) => {
  const r = await api('GET', `/api/trips/search?from=${from}&to=${to}&date=${date}`);
  assert.equal(r.status, 200, r.message);
  return dep ? r.data.trips.find(t => t.departure_time.startsWith(dep)) : r.data.trips[0];
};

const freeSeats = async (tripId, n = 1) => {
  const r = await api('GET', `/api/trips/${tripId}/seats`);
  return r.data.seats.filter(s => s.status === 'AVAILABLE').slice(0, n);
};

const passenger = (seat, i = 0) => ({ name: `Test Passenger ${i + 1}`, age: 30 + i, gender: i % 2 ? 'female' : 'male', seat_id: seat.id });
const contact = { name: 'Test Customer', phone: '9000009999', email: 'test.customer@example.com' };

before(async () => {
  const env = { ...process.env, DB_NAME: TEST_DB };
  const mysql = require('mysql2/promise');
  const root = await mysql.createConnection({ host: process.env.DB_HOST, port: process.env.DB_PORT, user: process.env.DB_USER, password: process.env.DB_PASSWORD });
  await root.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
  await root.end();
  execFileSync(process.execPath, [path.join(__dirname, '../scripts/migrate.js')], { env, stdio: 'pipe' });
  execFileSync(process.execPath, [path.join(__dirname, '../scripts/seed.js')], { env, stdio: 'pipe' });

  const app = require('../src/server');
  ({ pool } = require('../src/config/database'));
  ({ todayIST: today } = require('../src/utils/time'));
  const { addMinutesToDateTime } = require('../src/utils/time');
  day = (n) => addMinutesToDateTime(today(), '00:00:00', n * 1440).slice(0, 10);
  await new Promise(resolve => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  adminToken = await login(process.env.SEED_ADMIN_EMAIL, process.env.SEED_ADMIN_PASSWORD);
  assert.ok(adminToken, 'admin login failed');
});

after(async () => {
  server?.close();
  await pool?.end();
});

// ------------------------------------------------------------ search & fares

test('search finds Pune → Kolhapur trips with DB fares (incl. -10% trip adjustment)', async () => {
  const r = await api('GET', `/api/trips/search?from=pune&to=kolhapur&date=${day(7)}`);
  assert.equal(r.status, 200);
  const fares = r.data.trips.map(t => [t.route_slug, t.departure_time.slice(0, 5), t.starting_fare]);
  // The overnight Goa sleeper also passes through Kolhapur, priced from its own segment fare
  assert.deepEqual(fares, [['pune-to-kolhapur', '06:00', 500], ['pune-to-kolhapur', '08:00', 450], ['pune-to-goa', '21:00', 550]]);
  assert.ok(r.data.trips[0].available_seats > 0 && r.data.trips[0].available_seats <= 40);
});

test('search works for an intermediate segment (Satara → Kolhapur)', async () => {
  const r = await api('GET', `/api/trips/search?from=satara&to=kolhapur&date=${day(7)}`);
  const kolhapurTrip = r.data.trips.find(t => t.route_slug === 'pune-to-kolhapur' && t.departure_time.startsWith('06:00'));
  assert.equal(kolhapurTrip.starting_fare, 300);
  assert.equal(kolhapurTrip.boarding_stop.departure_at, `${day(7)} 07:50:00`);
  assert.ok(r.data.trips.some(t => t.route_slug === 'pune-to-goa'), 'Goa route also passes Satara → Kolhapur');
});

test('search validation: same From/To and past dates are rejected', async () => {
  assert.equal((await api('GET', `/api/trips/search?from=pune&to=pune&date=${day(1)}`)).status, 422);
  assert.equal((await api('GET', `/api/trips/search?from=pune&to=mumbai&date=${day(-1)}`)).status, 422);
});

test('fare endpoint computes segment fare server-side and enforces stop order', async () => {
  const trip = await searchTrip('pune', 'kolhapur', day(7), '06:00');
  const detail = (await api('GET', `/api/trips/${trip.id}`)).data;
  const stop = (city) => detail.stops.find(s => s.location_city === city).id;
  const ok = await api('GET', `/api/trips/${trip.id}/fare?boarding_stop_id=${stop('Satara')}&dropping_stop_id=${stop('Karad')}`);
  assert.equal(ok.data.fare_per_seat, 150);
  const bad = await api('GET', `/api/trips/${trip.id}/fare?boarding_stop_id=${stop('Karad')}&dropping_stop_id=${stop('Satara')}`);
  assert.equal(bad.status, 400);
});

// ------------------------------------------------------------ seats

test('seat locks block other sessions and can be released', async () => {
  const trip = await searchTrip('pune', 'kolhapur', day(8), '06:00');
  const [seat] = await freeSeats(trip.id);
  const a = await api('POST', `/api/trips/${trip.id}/seats/lock`, { body: { seat_ids: [seat.id] } });
  assert.equal(a.status, 200);
  const b = await api('POST', `/api/trips/${trip.id}/seats/lock`, { body: { seat_ids: [seat.id] } });
  assert.equal(b.status, 409);
  const map = await api('GET', `/api/trips/${trip.id}/seats?lock_token=${a.data.lock_token}`);
  const mine = map.data.seats.find(s => s.id === seat.id);
  assert.equal(mine.status, 'LOCKED'); assert.equal(mine.mine, true);
  await api('POST', `/api/trips/${trip.id}/seats/release`, { body: { lock_token: a.data.lock_token } });
  const after_ = await api('GET', `/api/trips/${trip.id}/seats`);
  assert.equal(after_.data.seats.find(s => s.id === seat.id).status, 'AVAILABLE');
});

// ------------------------------------------------------------ cash flow

test('cash booking: reserved/pending with server fare; admin marks paid → confirmed', async () => {
  const trip = await searchTrip('pune', 'kolhapur', day(8), '06:00');
  const detail = (await api('GET', `/api/trips/${trip.id}`)).data;
  const seats = await freeSeats(trip.id, 2);
  const lock = await api('POST', `/api/trips/${trip.id}/seats/lock`, { body: { seat_ids: seats.map(s => s.id) } });
  const create = await api('POST', '/api/bookings', {
    body: {
      trip_id: trip.id, boarding_stop_id: detail.stops[0].id, dropping_stop_id: detail.stops.at(-1).id,
      passengers: seats.map(passenger), contact, payment_method: 'CASH', lock_token: lock.data.lock_token,
      total_amount: 1, payment_status: 'paid', booking_status: 'confirmed', mark_paid_now: true, // must all be ignored
    },
  });
  assert.equal(create.status, 201, create.message);
  assert.match(create.data.booking_number, /^GT\d{4}1\d{5}$/);
  assert.equal(create.data.total_amount, 1000);
  assert.equal(create.data.booking_status, 'reserved');
  assert.equal(create.data.payment_status, 'pending');

  const [[b]] = await pool.query('SELECT id FROM bookings WHERE booking_number = ?', [create.data.booking_number]);
  const [[p]] = await pool.query('SELECT id FROM payments WHERE booking_id = ?', [b.id]);

  const wrongAmount = await api('POST', `/api/admin/payments/${p.id}/mark-paid`, { token: adminToken, body: { amount: 500 } });
  assert.equal(wrongAmount.status, 400);
  const verifyCash = await api('POST', `/api/admin/payments/${p.id}/verify`, { token: adminToken, body: {} });
  assert.equal(verifyCash.status, 400, 'verify is a UPI action, not cash');

  const paid = await api('POST', `/api/admin/payments/${p.id}/mark-paid`, { token: adminToken, body: { amount: 1000, transaction_reference: 'CASH-TEST-1' } });
  assert.equal(paid.status, 200, paid.message);
  assert.equal(paid.data.payment_status, 'paid');
  assert.equal(paid.data.booking_status, 'confirmed');
});

// ------------------------------------------------------------ double booking

test('a booked seat cannot be booked again, even concurrently', async () => {
  const trip = await searchTrip('pune', 'mumbai', day(9), '07:30');
  const detail = (await api('GET', `/api/trips/${trip.id}`)).data;
  const [seat] = await freeSeats(trip.id);
  const body = (i) => ({
    trip_id: trip.id, boarding_stop_id: detail.stops[0].id, dropping_stop_id: detail.stops.at(-1).id,
    passengers: [passenger(seat)], contact: { ...contact, phone: `900000880${i}` }, payment_method: 'CASH',
  });
  const results = await Promise.all([0, 1, 2, 3].map(i => api('POST', '/api/bookings', { body: body(i) })));
  const statuses = results.map(r => r.status).sort();
  assert.deepEqual(statuses, [201, 409, 409, 409]);
  const again = await api('POST', '/api/bookings', { body: body(5) });
  assert.equal(again.status, 409);
  const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM trip_seats WHERE trip_id = ? AND seat_id = ?', [trip.id, seat.id]);
  assert.equal(n, 1);
});

// ------------------------------------------------------------ QR flow

test('UPI QR booking stays verification-pending until an admin verifies it', async () => {
  const opts = await api('GET', '/api/payment-settings');
  const qr = opts.data.find(o => o.payment_method === 'UPI_QR');
  assert.ok(qr.qr_image && qr.upi_id, 'QR configured from DB');

  const trip = await searchTrip('pune', 'nashik', day(9), '08:00');
  const detail = (await api('GET', `/api/trips/${trip.id}`)).data;
  const [seat] = await freeSeats(trip.id);
  const create = await api('POST', '/api/bookings', {
    body: { trip_id: trip.id, boarding_stop_id: detail.stops[0].id, dropping_stop_id: detail.stops.at(-1).id, passengers: [passenger(seat)], contact, payment_method: 'UPI_QR', upi_reference: '123456789012' },
  });
  assert.equal(create.status, 201);
  assert.equal(create.data.payment_status, 'verification_pending');
  assert.equal(create.data.booking_status, 'pending');

  const lookup = await api('GET', `/api/bookings/lookup?booking_number=${create.data.booking_number}&phone=${contact.phone}`);
  assert.equal(lookup.data.payment_status, 'verification_pending');
  const wrongPhone = await api('GET', `/api/bookings/lookup?booking_number=${create.data.booking_number}&phone=9000000000`);
  assert.equal(wrongPhone.status, 404);

  const [[p]] = await pool.query('SELECT p.id FROM payments p JOIN bookings b ON b.id = p.booking_id WHERE b.booking_number = ?', [create.data.booking_number]);
  assert.equal((await api('POST', `/api/admin/payments/${p.id}/verify`, { body: {} })).status, 401, 'no token');
  const v = await api('POST', `/api/admin/payments/${p.id}/verify`, { token: adminToken, body: { transaction_reference: 'UTR123456789012' } });
  assert.equal(v.status, 200, v.message);
  const after_ = await api('GET', `/api/bookings/lookup?booking_number=${create.data.booking_number}&phone=${contact.phone}`);
  assert.equal(after_.data.payment_status, 'paid');
  assert.equal(after_.data.booking_status, 'confirmed');
});

test('admin can reject a QR payment (remark required)', async () => {
  const [[p]] = await pool.query("SELECT p.id FROM payments p JOIN bookings b ON b.id = p.booking_id WHERE b.booking_number = 'GT2026100001'");
  assert.equal((await api('POST', `/api/admin/payments/${p.id}/reject`, { token: adminToken, body: {} })).status, 400);
  const r = await api('POST', `/api/admin/payments/${p.id}/reject`, { token: adminToken, body: { remarks: 'UTR not found in bank statement' } });
  assert.equal(r.status, 200);
  assert.equal(r.data.payment_status, 'failed');
});

// ------------------------------------------------------------ cancellation

test('cancelling releases seats; cancelled bookings cannot be paid', async () => {
  const trip = await searchTrip('mumbai', 'pune', day(10), '14:30');
  const detail = (await api('GET', `/api/trips/${trip.id}`)).data;
  const [seat] = await freeSeats(trip.id);
  const create = await api('POST', '/api/bookings', {
    body: { trip_id: trip.id, boarding_stop_id: detail.stops[0].id, dropping_stop_id: detail.stops.at(-1).id, passengers: [passenger(seat)], contact, payment_method: 'CASH' },
  });
  const cancel = await api('POST', `/api/bookings/${create.data.booking_number}/cancel`, { body: { phone: contact.phone, reason: 'test' } });
  assert.equal(cancel.status, 200, cancel.message);
  assert.equal(cancel.data.booking_status, 'cancelled');
  assert.equal(cancel.data.payment_status, 'not_applicable');
  const seatsAfter = await api('GET', `/api/trips/${trip.id}/seats`);
  assert.equal(seatsAfter.data.seats.find(s => s.id === seat.id).status, 'AVAILABLE');

  const [[p]] = await pool.query('SELECT p.id FROM payments p JOIN bookings b ON b.id = p.booking_id WHERE b.booking_number = ?', [create.data.booking_number]);
  assert.equal((await api('POST', `/api/admin/payments/${p.id}/mark-paid`, { token: adminToken, body: {} })).status, 400);
});

test('paid booking cancelled by admin becomes refund pending, then refunded', async () => {
  const [[b]] = await pool.query("SELECT id FROM bookings WHERE booking_number = 'GT2026100003'");
  const c = await api('POST', `/api/admin/bookings/${b.id}/cancel`, { token: adminToken, body: { reason: 'Customer request at counter' } });
  assert.equal(c.data.payment_status, 'refund_pending');
  const [[p]] = await pool.query('SELECT id FROM payments WHERE booking_id = ?', [b.id]);
  const r = await api('POST', `/api/admin/payments/${p.id}/refund`, { token: adminToken, body: { transaction_reference: 'REFUND-1' } });
  assert.equal(r.data.payment_status, 'refunded');
});

// ------------------------------------------------------------ admin configuration → customer search

test('admin builds a new route end-to-end and customers can book it without frontend changes', async () => {
  const loc = await api('POST', '/api/admin/locations', { token: adminToken, body: { name: 'Mahabaleshwar', city: 'Mahabaleshwar', state: 'Maharashtra' } });
  assert.equal(loc.status, 201, loc.message);
  const [[pune]] = await pool.query("SELECT id FROM locations WHERE slug = 'pune'");
  const [[wai]] = await pool.query("SELECT id FROM locations WHERE slug = 'satara'");

  assert.equal((await api('POST', '/api/admin/routes', { token: adminToken, body: { from_location_id: pune.id, to_location_id: pune.id } })).status, 422);
  const route = await api('POST', '/api/admin/routes', { token: adminToken, body: { from_location_id: pune.id, to_location_id: loc.data.id, distance_km: 120 } });
  assert.equal(route.status, 201, route.message);
  const rid = route.data.id;
  const existing = (await api('GET', `/api/admin/routes/${rid}`, { token: adminToken })).data.stops;

  // Wrong order (destination first) is rejected
  const badStops = await api('PUT', `/api/admin/routes/${rid}/stops`, { token: adminToken, body: { stops: [
    { location_id: loc.data.id, stop_name: 'Mahabaleshwar', arrival_time: '09:00' },
    { location_id: pune.id, stop_name: 'Pune', departure_time: '06:00', boarding_allowed: true },
  ] } });
  assert.equal(badStops.status, 400);

  const stops = await api('PUT', `/api/admin/routes/${rid}/stops`, { token: adminToken, body: { stops: [
    { id: existing[0].id, location_id: pune.id, stop_name: 'Pune (Swargate)', departure_time: '06:30', boarding_allowed: true },
    { location_id: wai.id, stop_name: 'Satara Bypass', arrival_time: '08:00', departure_time: '08:05', boarding_allowed: true, dropping_allowed: true },
    { id: existing[1].id, location_id: loc.data.id, stop_name: 'Mahabaleshwar Bus Stand', arrival_time: '09:30', dropping_allowed: true },
  ] } });
  assert.equal(stops.status, 200, stops.message);
  const [s1, s2, s3] = stops.data.stops;

  const neg = await api('PUT', `/api/admin/routes/${rid}/fares`, { token: adminToken, body: { fares: [{ from_stop_id: s1.id, to_stop_id: s3.id, fare: -5 }] } });
  assert.equal(neg.status, 422);
  const fares = await api('PUT', `/api/admin/routes/${rid}/fares`, { token: adminToken, body: { fares: [
    { from_stop_id: s1.id, to_stop_id: s2.id, fare: 200 }, { from_stop_id: s1.id, to_stop_id: s3.id, fare: 380 }, { from_stop_id: s2.id, to_stop_id: s3.id, fare: 180 },
  ] } });
  assert.equal(fares.status, 200, fares.message);

  const [[veh]] = await pool.query("SELECT id FROM vehicles WHERE registration_number = 'MH12EF9012'");
  const trip = await api('POST', '/api/admin/trips', { token: adminToken, body: { route_id: rid, vehicle_id: veh.id, travel_date: day(12), departure_time: '15:00' } });
  assert.equal(trip.status, 201, trip.message);
  const clash = await api('POST', '/api/admin/trips', { token: adminToken, body: { route_id: rid, vehicle_id: veh.id, travel_date: day(12), departure_time: '16:00' } });
  assert.equal(clash.status, 409, 'vehicle double-scheduling is rejected');

  const search = await api('GET', `/api/trips/search?from=pune&to=${loc.data.slug}&date=${day(12)}`);
  assert.equal(search.data.trips.length, 1);
  assert.equal(search.data.trips[0].starting_fare, 380);
  assert.equal(search.data.trips[0].dropping_stop.arrival_at, `${day(12)} 18:00:00`, 'stop times shift with trip departure');

  // Inactive route cannot be booked
  await api('PUT', `/api/admin/routes/${rid}`, { token: adminToken, body: { is_active: false } });
  const detail = (await api('GET', `/api/trips/${trip.data.id}`)).data;
  assert.equal(detail.bookable, false);
  const [seat] = (await api('GET', `/api/trips/${trip.data.id}/seats`)).data.seats;
  const blocked = await api('POST', '/api/bookings', { body: { trip_id: trip.data.id, boarding_stop_id: s1.id, dropping_stop_id: s3.id, passengers: [passenger(seat)], contact, payment_method: 'CASH' } });
  assert.equal(blocked.status, 400);
});

test('completed trips cannot accept bookings', async () => {
  const [[t]] = await pool.query("SELECT t.id, t.route_id FROM trips t WHERE t.status = 'completed' LIMIT 1");
  const detail = (await api('GET', `/api/trips/${t.id}`)).data;
  const [seat] = (await api('GET', `/api/trips/${t.id}/seats`)).data.seats.filter(s => s.status === 'AVAILABLE');
  const r = await api('POST', '/api/bookings', { body: { trip_id: t.id, boarding_stop_id: detail.stops[0].id, dropping_stop_id: detail.stops.at(-1).id, passengers: [passenger(seat)], contact, payment_method: 'CASH' } });
  assert.equal(r.status, 400);
});

// ------------------------------------------------------------ RBAC

test('RBAC: manager can verify payments; content manager cannot; customers cannot reach admin APIs', async () => {
  const managerToken = await login('manager@ganrajtraveling.demo', process.env.SEED_ADMIN_PASSWORD);
  assert.ok(managerToken);
  const list = await api('GET', '/api/admin/payments?status=verification_pending', { token: managerToken });
  assert.equal(list.status, 200);
  assert.equal((await api('GET', '/api/admin/users', { token: managerToken })).status, 403);

  const [[role]] = await pool.query("SELECT id FROM roles WHERE name = 'content_manager'");
  const u = await api('POST', '/api/admin/users', { token: adminToken, body: { name: 'Content Person', email: 'content@example.com', role_id: role.id, password: 'Content123' } });
  assert.equal(u.status, 201, u.message);
  const contentToken = await login('content@example.com', 'Content123');
  assert.equal((await api('GET', '/api/admin/payments', { token: contentToken })).status, 403);
  assert.equal((await api('PUT', '/api/admin/payment-settings/UPI_QR', { token: contentToken, body: { status: 'INACTIVE' } })).status, 403);

  const reg = await api('POST', '/api/auth/register', { body: { name: 'Web Customer', email: 'web.customer@example.com', phone: '9000007777', password: 'WebCust123' } });
  assert.equal(reg.status, 201, reg.message);
  assert.equal((await api('GET', '/api/admin/bookings', { token: reg.data.token })).status, 403);
  assert.equal((await api('GET', '/api/bookings/my', { token: reg.data.token })).status, 200);
});

// ------------------------------------------------------------ QR settings & upload

test('QR upload validates file content; UPI cannot be activated without QR + UPI ID', async () => {
  const fake = new FormData();
  fake.append('qr', new Blob(['<?php echo 1; ?>'], { type: 'image/png' }), 'evil.png');
  assert.equal((await api('POST', '/api/admin/payment-settings/UPI_QR/qr', { token: adminToken, form: fake })).status, 400);

  const exe = new FormData();
  exe.append('qr', new Blob(['MZ'], { type: 'application/octet-stream' }), 'qr.exe');
  assert.equal((await api('POST', '/api/admin/payment-settings/UPI_QR/qr', { token: adminToken, form: exe })).status, 400);

  const png = fs.readFileSync(path.join(__dirname, '../uploads/payment/demo-ganraj-qr.png'));
  const good = new FormData();
  good.append('qr', new Blob([png], { type: 'image/png' }), 'my qr.png');
  const up = await api('POST', '/api/admin/payment-settings/UPI_QR/qr', { token: adminToken, form: good });
  assert.equal(up.status, 200, up.message);
  assert.match(up.data.qr_image, /^\/uploads\/payment\/upi-qr-[0-9a-f-]+\.png$/);

  const badUpi = await api('PUT', '/api/admin/payment-settings/UPI_QR', { token: adminToken, body: { upi_id: 'not a upi' } });
  assert.equal(badUpi.status, 422);
  const ok = await api('PUT', '/api/admin/payment-settings/UPI_QR', { token: adminToken, body: { upi_id: 'ganraj.test@okbank', display_name: 'Ganraj Test' } });
  assert.equal(ok.status, 200);

  // Restore the demo QR file for other runs (upload deleted the previous one only if it was an upload)
  assert.ok(fs.existsSync(path.join(__dirname, '../uploads/payment/demo-ganraj-qr.png')));
  fs.unlinkSync(path.join(__dirname, '../uploads', up.data.qr_image.replace('/uploads/', '')));
});

// ------------------------------------------------------------ audit & dashboard

test('audit log records admin actions; dashboard reports demo stats', async () => {
  const logs = await api('GET', '/api/admin/audit-logs?limit=200', { token: adminToken });
  const actions = new Set(logs.data.map(l => l.action));
  ['payment.verify', 'payment.mark_paid', 'payment.reject', 'booking.cancel', 'route.fares.update', 'route.stops.update', 'trip.create', 'location.create', 'payment_settings.update', 'payment_settings.qr.replace']
    .forEach(a => assert.ok(actions.has(a), `missing audit action ${a}`));
  const fareLog = logs.data.find(l => l.action === 'route.fares.update');
  assert.ok(fareLog.new_values && fareLog.user_name);

  const dash = await api('GET', '/api/admin/dashboard', { token: adminToken });
  assert.equal(dash.status, 200);
  assert.ok(dash.data.stats.today_bookings >= 12);
  assert.ok(dash.data.stats.active_routes >= 5);
  assert.ok(dash.data.stats.pending_payments >= 1);
  assert.equal(dash.data.trend.length, 14);
});
