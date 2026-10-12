/**
 * Ganraj Traveling demo/seed data (idempotent - safe to re-run).
 *
 *   npm run db:seed
 *
 * - Admin user from SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD (.env). Never hardcoded.
 * - Locations, operators, seat layouts, vehicles, routes with stops & segment fares,
 *   schedules and trips (from 7 days ago to 21 days ahead of today).
 * - UPI QR payment settings with a clearly-marked DEMO QR image.
 * - Fictional demo customers and bookings (only when the bookings table is empty).
 *
 * All people, emails and phone numbers are fictional (example.com, 90000xxxxx).
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const fs = require('fs');
const bcrypt = require('bcrypt');
const QRCode = require('qrcode');
const { pool, withTransaction } = require('../src/config/database');
const { generateSeats } = require('../src/routes/admin/seatLayouts');
const { generateTripsForSchedule } = require('../src/services/tripAdmin.service');
const { adjustedFare, getRouteStops } = require('../src/services/trip.service');
const { tripStopSchedule, todayIST, nowIST, addMinutesToDateTime } = require('../src/utils/time');

if (process.env.NODE_ENV === 'production' && !process.argv.includes('--force')) {
  console.error('Refusing to load demo data with NODE_ENV=production (use --force if you really mean it).');
  process.exit(1);
}

const TODAY = todayIST();
const day = (offset) => addMinutesToDateTime(TODAY, '00:00:00', offset * 1440).slice(0, 10);

// Deterministic pseudo-random numbers so re-seeding a fresh DB gives the same demo
let rngState = 20261008;
const rand = () => { rngState = (rngState * 1103515245 + 12345) % 2147483648; return rngState / 2147483648; };
const pickOne = (arr) => arr[Math.floor(rand() * arr.length)];

// ------------------------------------------------------------------ data

const LOCATIONS = [
  ['pune', 'Pune', 'Pune', 'Maharashtra', 18.5204, 73.8567, 1],
  ['mumbai', 'Mumbai', 'Mumbai', 'Maharashtra', 19.0760, 72.8777, 1],
  ['kolhapur', 'Kolhapur', 'Kolhapur', 'Maharashtra', 16.7050, 74.2433, 1],
  ['satara', 'Satara', 'Satara', 'Maharashtra', 17.6805, 74.0183, 0],
  ['karad', 'Karad', 'Karad', 'Maharashtra', 17.2890, 74.1817, 0],
  ['nashik', 'Nashik', 'Nashik', 'Maharashtra', 20.0059, 73.7897, 1],
  ['sangli', 'Sangli', 'Sangli', 'Maharashtra', 16.8524, 74.5815, 0],
  ['goa', 'Goa', 'Goa', 'Goa', 15.4909, 73.8278, 1],
  ['lonavala', 'Lonavala', 'Lonavala', 'Maharashtra', 18.7537, 73.4062, 1],
  ['panvel', 'Panvel', 'Panvel', 'Maharashtra', 18.9894, 73.1175, 0],
  ['sangamner', 'Sangamner', 'Sangamner', 'Maharashtra', 19.5678, 74.2115, 0],
  ['belgaum', 'Belgaum', 'Belagavi', 'Karnataka', 15.8497, 74.4977, 0],
];

const OPERATORS = [
  { name: 'Ganraj Traveling', contact_person: 'Operations Desk', phone: '9000000100', email: 'operations@example.com', address: 'Demo Office, Swargate, Pune' },
  { name: 'Ganraj Partner Fleet', contact_person: 'Fleet Manager', phone: '9000000101', email: 'fleet@example.com', address: 'Demo Depot, Hadapsar, Pune' },
];

const LAYOUTS = [
  { name: 'Seater 2+2 (40 seats)', seat_type: 'seater', decks: 1, rows_count: 10, cols_count: 4, aisle_after_col: 2, description: '10 rows, 2 + 2 seating with a centre aisle' },
  { name: 'Sleeper 1+2 Double Deck (30 berths)', seat_type: 'sleeper', decks: 2, rows_count: 5, cols_count: 3, aisle_after_col: 1, description: 'Lower and upper deck, 1 + 2 berths per row' },
];

const VEHICLES = [
  { registration_number: 'MH12AB1234', name: 'Ganraj Express', type: 'bus', layout: 0, is_ac: 1, operator: 0, amenities: ['AC', 'Charging Point', 'Water Bottle', 'Reading Light', 'Push Back Seat'] },
  { registration_number: 'MH14CD5678', name: 'Ganraj Premium', type: 'sleeper_bus', layout: 1, is_ac: 1, operator: 0, amenities: ['AC', 'Blanket', 'Charging Point', 'Water Bottle', 'Reading Light'] },
  { registration_number: 'MH12EF9012', name: 'Ganraj Travels', type: 'bus', layout: 0, is_ac: 0, operator: 0, amenities: ['Charging Point', 'Push Back Seat'] },
  { registration_number: 'MH12GH3456', name: 'Ganraj Travels', type: 'bus', layout: 0, is_ac: 0, operator: 1, amenities: ['Charging Point', 'Push Back Seat'] },
  { registration_number: 'MH14JK7890', name: 'Ganraj Premium', type: 'sleeper_bus', layout: 1, is_ac: 1, operator: 1, amenities: ['AC', 'Blanket', 'Charging Point', 'Water Bottle', 'Reading Light'] },
];

// stops: [location slug, stop name, arrival, departure]
const ROUTES = [
  {
    slug: 'pune-to-kolhapur', from: 'pune', to: 'kolhapur', distance: 230, popular: 1,
    description: 'Pune to Kolhapur via Satara and Karad on the NH-48 corridor.',
    stops: [['pune', 'Pune (Swargate)', null, '06:00'], ['satara', 'Satara', '07:45', '07:50'], ['karad', 'Karad', '09:15', '09:20'], ['kolhapur', 'Kolhapur (CBS)', '11:00', null]],
    fares: { 'pune>satara': 250, 'pune>karad': 350, 'pune>kolhapur': 500, 'satara>karad': 150, 'satara>kolhapur': 300, 'karad>kolhapur': 180 },
  },
  {
    slug: 'pune-to-mumbai', from: 'pune', to: 'mumbai', distance: 150, popular: 1,
    description: 'Pune to Mumbai via the Expressway with stops at Lonavala and Panvel.',
    stops: [['pune', 'Pune (Wakad)', null, '07:30'], ['lonavala', 'Lonavala', '08:45', '08:50'], ['panvel', 'Panvel', '10:00', '10:05'], ['mumbai', 'Mumbai (Dadar)', '11:00', null]],
    fares: { 'pune>lonavala': 200, 'pune>panvel': 350, 'pune>mumbai': 450, 'lonavala>panvel': 200, 'lonavala>mumbai': 300, 'panvel>mumbai': 150 },
  },
  {
    slug: 'pune-to-nashik', from: 'pune', to: 'nashik', distance: 212, popular: 1,
    description: 'Pune to Nashik via Sangamner.',
    stops: [['pune', 'Pune (Shivajinagar)', null, '08:00'], ['sangamner', 'Sangamner', '11:00', '11:10'], ['nashik', 'Nashik (CBS)', '13:00', null]],
    fares: { 'pune>sangamner': 300, 'pune>nashik': 400, 'sangamner>nashik': 150 },
  },
  {
    slug: 'pune-to-goa', from: 'pune', to: 'goa', distance: 460, popular: 1,
    description: 'Overnight sleeper from Pune to Goa via Satara, Kolhapur and Belgaum.',
    stops: [['pune', 'Pune (Swargate)', null, '21:00'], ['satara', 'Satara', '22:45', '22:50'], ['kolhapur', 'Kolhapur (CBS)', '01:00', '01:15'], ['belgaum', 'Belgaum', '03:15', '03:25'], ['goa', 'Goa (Panaji)', '07:00', null]],
    fares: {
      'pune>satara': 300, 'pune>kolhapur': 550, 'pune>belgaum': 700, 'pune>goa': 900, 'satara>kolhapur': 400,
      'satara>belgaum': 550, 'satara>goa': 750, 'kolhapur>belgaum': 300, 'kolhapur>goa': 500, 'belgaum>goa': 350,
    },
  },
  {
    slug: 'mumbai-to-pune', from: 'mumbai', to: 'pune', distance: 150, popular: 1,
    description: 'Mumbai to Pune via Panvel and Lonavala.',
    stops: [['mumbai', 'Mumbai (Dadar)', null, '14:30'], ['panvel', 'Panvel', '15:15', '15:20'], ['lonavala', 'Lonavala', '16:40', '16:45'], ['pune', 'Pune (Wakad)', '18:00', null]],
    fares: { 'mumbai>panvel': 150, 'mumbai>lonavala': 300, 'mumbai>pune': 450, 'panvel>lonavala': 200, 'panvel>pune': 350, 'lonavala>pune': 200 },
  },
];

// [route slug, vehicle reg, departure, arrival, fare adjustment %]
const SCHEDULES = [
  ['pune-to-kolhapur', 'MH12AB1234', '06:00', '11:00', 0],
  ['pune-to-kolhapur', 'MH12EF9012', '08:00', '13:30', -10],
  ['pune-to-mumbai', 'MH14CD5678', '07:30', '11:00', 0],
  ['mumbai-to-pune', 'MH14CD5678', '14:30', '18:00', 0],
  ['pune-to-nashik', 'MH12GH3456', '08:00', '13:00', 0],
  ['pune-to-goa', 'MH14JK7890', '21:00', '07:00', 0],
];

const SETTINGS = [
  ['company_name', 'Ganraj Traveling', 'text', 'general', 'Company Name'],
  ['company_tagline', 'Travel Easy. Travel Safe. Travel with Ganraj.', 'text', 'general', 'Tagline'],
  ['company_phone', '+91 90000 00100', 'text', 'general', 'Phone Number'],
  ['company_email', 'support@ganrajtraveling.example.com', 'text', 'general', 'Email'],
  ['company_address', 'Demo Office, Near Swargate Bus Stand, Pune 411042, Maharashtra', 'text', 'general', 'Address'],
  ['company_city', 'Pune', 'text', 'general', 'City'],
  ['whatsapp_number', '919000000100', 'text', 'general', 'WhatsApp Number (digits only, with country code)'],
  ['support_hours', 'Every day, 6:00 AM - 11:00 PM', 'text', 'general', 'Support Hours'],
  ['currency_symbol', '₹', 'text', 'pricing', 'Currency Symbol'],
  ['meta_title_suffix', '| Ganraj Traveling', 'text', 'seo', 'Meta Title Suffix'],
  ['homepage_seo_title', 'Ganraj Traveling - Bus Tickets Pune, Mumbai, Kolhapur, Nashik & Goa', 'text', 'seo', 'Homepage SEO Title'],
  ['homepage_meta_desc', 'Book bus seats with Ganraj Traveling. Choose your boarding point, pick your seat and pay by cash or UPI.', 'text', 'seo', 'Homepage Meta Description'],
  ['homepage_reviews', JSON.stringify([
    { name: 'Demo Reviewer A', route: 'Pune → Kolhapur', rating: 5, text: 'Bus left on time from Swargate and the seat I picked online was exactly the one I got.' },
    { name: 'Demo Reviewer B', route: 'Pune → Goa', rating: 5, text: 'The sleeper was clean and the UPI payment was confirmed within the hour.' },
    { name: 'Demo Reviewer C', route: 'Mumbai → Pune', rating: 4, text: 'Easy to book for my parents and pay cash at the counter. Helpful staff.' },
  ]), 'json', 'content', 'Homepage reviews (demo)'],
];

const FIRST = ['Rohan', 'Priya', 'Sachin', 'Pooja', 'Vikram', 'Neha', 'Akash', 'Snehal', 'Omkar', 'Rutuja', 'Tejas', 'Kavya', 'Nikhil', 'Aarti', 'Prasad', 'Shruti', 'Mahesh', 'Anjali', 'Ganesh', 'Swati'];
const LAST = ['Patil', 'Shinde', 'Jadhav', 'Pawar', 'Deshmukh', 'Kulkarni', 'More', 'Gaikwad', 'Chavan', 'Joshi'];

// ------------------------------------------------------------------ helpers

const idBy = async (conn, table, col, val) => {
  const [rows] = await conn.query(`SELECT id FROM ${table} WHERE ${col} = ?`, [val]);
  return rows[0]?.id || null;
};

const log = (msg) => console.log(`  • ${msg}`);

// ------------------------------------------------------------------ steps

const seedAdmin = async (conn) => {
  const email = (process.env.SEED_ADMIN_EMAIL || '').toLowerCase().trim();
  const password = process.env.SEED_ADMIN_PASSWORD || '';
  if (!email || password.length < 8) {
    log('SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD not set (min 8 chars) - skipping admin user');
    return null;
  }
  const roleId = await idBy(conn, 'roles', 'name', 'super_admin');
  const existing = await idBy(conn, 'users', 'email', email);
  if (existing) {
    if (process.argv.includes('--reset-admin')) {
      await conn.query('UPDATE users SET password_hash = ?, is_active = 1 WHERE id = ?', [await bcrypt.hash(password, 12), existing]);
      log(`admin ${email} password reset`);
    } else log(`admin ${email} already exists`);
    return existing;
  }
  const [r] = await conn.query('INSERT INTO users (role_id, name, email, phone, password_hash) VALUES (?, ?, ?, ?, ?)',
    [roleId, 'Demo Super Admin', email, '9000000001', await bcrypt.hash(password, 12)]);
  log(`admin user ${email} created (Super Admin)`);

  // A demo manager to show role-based access
  const managerRole = await idBy(conn, 'roles', 'name', 'manager');
  if (!(await idBy(conn, 'users', 'email', 'manager@ganrajtraveling.demo'))) {
    await conn.query('INSERT INTO users (role_id, name, email, phone, password_hash, is_active) VALUES (?, ?, ?, ?, ?, 1)',
      [managerRole, 'Demo Booking Manager', 'manager@ganrajtraveling.demo', '9000000002', await bcrypt.hash(password, 12)]);
    log('demo manager manager@ganrajtraveling.demo created (same password, Manager role)');
  }
  return r.insertId;
};

const seedSettings = async (conn) => {
  for (const [key, value, type, group, label] of SETTINGS) {
    // Insert new keys; only overwrite values still carrying the old template branding
    await conn.query(
      `INSERT INTO settings (\`key\`, value, type, group_name, label) VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE value = IF(value IS NULL OR value = '' OR value LIKE '%SwiftRoute%' OR value LIKE '%swiftroute%' OR \`key\` IN ('company_phone','whatsapp_number','company_address'), VALUES(value), value)`,
      [key, value, type, group, label]
    );
  }
  log(`${SETTINGS.length} settings ensured`);
};

const seedLocations = async (conn) => {
  const ids = {};
  for (const [slug, name, city, state, lat, lng, popular] of LOCATIONS) {
    await conn.query(
      `INSERT INTO locations (name, city, state, slug, latitude, longitude, is_popular, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, 1)
       ON DUPLICATE KEY UPDATE is_active = 1`,
      [name, city, state, slug, lat, lng, popular]
    );
    ids[slug] = await idBy(conn, 'locations', 'slug', slug);
  }
  log(`${LOCATIONS.length} locations`);
  return ids;
};

const seedFleet = async (conn) => {
  const opIds = [];
  for (const o of OPERATORS) {
    await conn.query('INSERT IGNORE INTO operators SET ?', [o]);
    opIds.push(await idBy(conn, 'operators', 'name', o.name));
  }
  const layoutIds = [];
  for (const l of LAYOUTS) {
    let id = await idBy(conn, 'seat_layouts', 'name', l.name);
    if (!id) {
      const seats = generateSeats(l);
      const [r] = await conn.query('INSERT INTO seat_layouts SET ?', [{ ...l, total_seats: seats.length }]);
      id = r.insertId;
      await conn.query('INSERT INTO seat_layout_seats (seat_layout_id, seat_number, deck, row_no, col_no, seat_type) VALUES ?',
        [seats.map(s => [id, s.seat_number, s.deck, s.row_no, s.col_no, s.seat_type])]);
    }
    layoutIds.push(id);
  }
  const vehicleIds = {};
  for (const v of VEHICLES) {
    let id = await idBy(conn, 'vehicles', 'registration_number', v.registration_number);
    if (!id) {
      const layout = LAYOUTS[v.layout];
      const [r] = await conn.query('INSERT INTO vehicles SET ?', [{
        name: v.name, type: v.type, registration_number: v.registration_number,
        capacity: layout.rows_count * layout.cols_count * layout.decks, is_ac: v.is_ac, seat_type: layout.seat_type,
        seat_layout_id: layoutIds[v.layout], operator_id: opIds[v.operator], amenities: JSON.stringify(v.amenities),
        description: `${v.is_ac ? 'AC' : 'Non-AC'} ${layout.seat_type === 'sleeper' ? 'Sleeper' : 'Seater'} · ${layout.description}`,
        is_active: 1,
      }]);
      id = r.insertId;
    }
    vehicleIds[v.registration_number] = id;
  }
  log(`${OPERATORS.length} operators, ${LAYOUTS.length} seat layouts, ${VEHICLES.length} vehicles`);
  return vehicleIds;
};

const seedRoutes = async (conn, loc) => {
  const routeIds = {};
  for (const r of ROUTES) {
    let id = await idBy(conn, 'routes', 'slug', r.slug);
    if (!id) {
      const [ins] = await conn.query('INSERT INTO routes SET ?', [{
        from_location_id: loc[r.from], to_location_id: loc[r.to], slug: r.slug, distance_km: r.distance,
        description: r.description, is_popular: r.popular, is_active: 1,
        seo_title: `${r.stops[0][1].split(' (')[0]} to ${r.stops[r.stops.length - 1][1].split(' (')[0]} Bus | Ganraj Traveling`,
      }]);
      id = ins.insertId;
    } else {
      await conn.query('UPDATE routes SET is_active = 1, deleted_at = NULL, description = COALESCE(description, ?) WHERE id = ?', [r.description, id]);
    }
    routeIds[r.slug] = id;

    // Replace legacy pickup-point stops (no schedule times) when nothing references them
    const [stops] = await conn.query('SELECT id, departure_time, arrival_time FROM route_stops WHERE route_id = ?', [id]);
    const configured = stops.some(s => s.departure_time || s.arrival_time);
    if (!configured) {
      const [[{ n }]] = await conn.query('SELECT COUNT(*) AS n FROM bookings b JOIN route_stops s ON s.id = b.boarding_stop_id OR s.id = b.dropping_stop_id WHERE s.route_id = ?', [id]);
      if (n === 0) {
        await conn.query('DELETE FROM route_stops WHERE route_id = ?', [id]);
        let order = 0;
        for (const [slug, name, arr, dep] of r.stops) {
          order++;
          const first = order === 1; const last = order === r.stops.length;
          await conn.query('INSERT INTO route_stops SET ?', [{
            route_id: id, location_id: loc[slug], stop_name: name, stop_order: order,
            arrival_time: arr ? `${arr}:00` : null, departure_time: dep ? `${dep}:00` : null,
            pickup_time: dep ? `${dep}:00` : null, drop_time: arr ? `${arr}:00` : null,
            boarding_allowed: last ? 0 : 1, dropping_allowed: first ? 0 : 1,
            stop_type: first ? 'pickup' : last ? 'drop' : 'both', is_active: 1,
          }]);
        }
      }
    }

    // Segment fares
    const routeStops = await getRouteStops(id, { conn });
    const bySlug = {};
    routeStops.forEach(s => { const key = Object.keys(loc).find(k => loc[k] === s.location_id); bySlug[key] = s.id; });
    for (const [seg, fare] of Object.entries(r.fares)) {
      const [a, b] = seg.split('>');
      if (!bySlug[a] || !bySlug[b]) continue;
      await conn.query(
        `INSERT INTO route_fares (route_id, from_stop_id, to_stop_id, fare) VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE fare = fare`, [id, bySlug[a], bySlug[b], fare]
      );
    }
    const durMin = (() => {
      const sched = tripStopSchedule({ travel_date: TODAY, departure_time: `${r.stops[0][3]}:00` }, routeStops);
      return sched[sched.length - 1]?.arrival_offset || 0;
    })();
    await conn.query('UPDATE routes SET duration_minutes = ? WHERE id = ? AND duration_minutes <> ?', [durMin, id, durMin]);
  }
  log(`${ROUTES.length} routes with stops and segment fares`);
  return routeIds;
};

const seedSchedulesAndTrips = async (conn, routeIds, vehicleIds, adminId) => {
  let created = 0;
  for (const [slug, reg, dep, arr, pct] of SCHEDULES) {
    const routeId = routeIds[slug]; const vehicleId = vehicleIds[reg];
    let [rows] = await conn.query('SELECT * FROM schedules WHERE route_id = ? AND vehicle_id = ? AND departure_time = ?', [routeId, vehicleId, `${dep}:00`]);
    if (!rows.length) {
      await conn.query('INSERT INTO schedules SET ?', [{
        route_id: routeId, vehicle_id: vehicleId, departure_time: `${dep}:00`, arrival_time: `${arr}:00`,
        days_of_week: '0,1,2,3,4,5,6', start_date: day(-30), end_date: day(90), fare_adjustment_pct: pct, created_by: adminId,
      }]);
      [rows] = await conn.query('SELECT * FROM schedules WHERE route_id = ? AND vehicle_id = ? AND departure_time = ?', [routeId, vehicleId, `${dep}:00`]);
    }
    const result = await generateTripsForSchedule(conn, rows[0], day(-7), day(21), adminId, { allowPast: true });
    created += result.created;
  }
  // Past trips are completed; today's trips already on the road are running
  await conn.query("UPDATE trips SET status = 'completed' WHERE travel_date < ? AND status IN ('scheduled','boarding','running')", [TODAY]);
  await conn.query("UPDATE trips SET status = 'running' WHERE travel_date = ? AND departure_time <= ? AND status = 'scheduled'", [TODAY, nowIST().slice(11)]);
  log(`${SCHEDULES.length} schedules, ${created} new trip(s) generated (${day(-7)} → ${day(21)})`);
};

const seedPaymentSettings = async (conn) => {
  const [[qr]] = await conn.query("SELECT * FROM payment_settings WHERE payment_method = 'UPI_QR'");
  if (qr.qr_image) { log('UPI QR settings already configured'); return; }
  const dir = path.join(__dirname, '../uploads/payment');
  fs.mkdirSync(dir, { recursive: true });
  // The demo QR encodes a plain notice, NOT a UPI payment link, so scanning it can never send money anywhere.
  await QRCode.toFile(path.join(dir, 'demo-ganraj-qr.png'),
    'DEMO QR - Ganraj Traveling. This is not a payment QR. Upload your real UPI QR in Admin > Payment Management > QR Settings.',
    { width: 480, margin: 2, color: { dark: '#1a2744', light: '#ffffff' } });
  await conn.query(
    `UPDATE payment_settings SET display_name = 'Ganraj Traveling', upi_id = 'ganrajtraveling@upi',
       qr_image = '/uploads/payment/demo-ganraj-qr.png', status = 'ACTIVE',
       instructions = 'Scan the QR with any UPI app (GPay, PhonePe, Paytm, BHIM), pay the exact amount shown, then tap "I Have Paid". Your seat is confirmed after we verify the payment.'
     WHERE payment_method = 'UPI_QR'`
  );
  log('UPI QR payment settings activated with a DEMO QR image (replace it in Admin > QR Settings)');
};

const seedBookings = async (conn, adminId) => {
  const [[{ n }]] = await conn.query('SELECT COUNT(*) AS n FROM bookings');
  if (n > 0) { log(`bookings already present (${n}) - skipping demo bookings`); return; }

  const custPassword = process.env.SEED_CUSTOMER_PASSWORD || null;
  const hash = custPassword && custPassword.length >= 8 ? await bcrypt.hash(custPassword, 12) : null;

  const makeCustomer = async (name, email, phone, registered = false) => {
    const [r] = await conn.query('INSERT INTO customers (name, email, phone, password_hash) VALUES (?, ?, ?, ?)', [name, email, phone, registered ? hash : null]);
    return { id: r.insertId, name, email, phone };
  };

  const tripsFor = async (slug, date, dep) => {
    const [rows] = await conn.query(
      `SELECT t.*, v.seat_layout_id FROM trips t JOIN routes r ON r.id = t.route_id JOIN vehicles v ON v.id = t.vehicle_id
       WHERE r.slug = ? AND t.travel_date = ? ${dep ? 'AND t.departure_time = ?' : ''} ORDER BY t.departure_time`,
      dep ? [slug, date, `${dep}:00`] : [slug, date]
    );
    return rows;
  };

  const freeSeats = async (trip) => {
    const [rows] = await conn.query(
      `SELECT s.id, s.seat_number FROM seat_layout_seats s
       WHERE s.seat_layout_id = ? AND s.is_active = 1 AND s.id NOT IN (SELECT seat_id FROM trip_seats WHERE trip_id = ?)
       ORDER BY s.deck, s.row_no, s.col_no`, [trip.seat_layout_id, trip.id]
    );
    return rows;
  };

  /**
   * Inserts a booking exactly like the booking service would, with explicit timestamps.
   * spec: { trip, customer, seatNumbers?|count, segment?: [fromIdx, toIdx], method, bookingStatus, paymentStatus, createdAt, paidAt?, upiRef? }
   */
  const insertBooking = async (spec) => {
    const stops = await getRouteStops(spec.trip.route_id, { conn });
    const [fromIdx, toIdx] = spec.segment || [0, stops.length - 1];
    const boarding = stops[fromIdx]; const dropping = stops[toIdx];
    const [[fareRow]] = await conn.query('SELECT fare FROM route_fares WHERE route_id = ? AND from_stop_id = ? AND to_stop_id = ?', [spec.trip.route_id, boarding.id, dropping.id]);
    const fare = adjustedFare(fareRow.fare, spec.trip.fare_adjustment_pct);

    const free = await freeSeats(spec.trip);
    let seats;
    if (spec.seatNumbers) seats = spec.seatNumbers.map(num => free.find(s => s.seat_number === num)).filter(Boolean);
    else {
      const start = Math.floor(rand() * Math.max(1, free.length - spec.count));
      seats = free.slice(start, start + spec.count);
    }
    if (!seats.length) return null;
    const total = fare * seats.length;

    const [ins] = await conn.query(
      `INSERT INTO bookings (booking_number, customer_id, trip_id, boarding_stop_id, dropping_stop_id, contact_name, contact_phone, contact_email,
         seat_count, fare_per_seat, total_amount, payment_method, booking_status, payment_status, source, created_by,
         cancelled_at, cancelled_by_type, cancellation_reason, created_at, updated_at)
       VALUES (CONCAT('TMP', LEFT(REPLACE(UUID(), '-', ''), 27)), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [spec.customer.id, spec.trip.id, boarding.id, dropping.id, spec.customer.name, spec.customer.phone, spec.customer.email,
        seats.length, fare, total, spec.method, spec.bookingStatus, spec.paymentStatus, spec.source || 'website',
        spec.source === 'admin' ? adminId : null,
        spec.bookingStatus === 'cancelled' ? spec.createdAt : null, spec.bookingStatus === 'cancelled' ? 'customer' : null,
        spec.bookingStatus === 'cancelled' ? 'Change of travel plans (demo)' : null, spec.createdAt, spec.createdAt]
    );
    const id = ins.insertId;
    const number = `GT${spec.createdAt.slice(0, 4)}${100000 + id}`;
    await conn.query('UPDATE bookings SET booking_number = ? WHERE id = ?', [number, id]);

    const genders = ['male', 'female'];
    for (let i = 0; i < seats.length; i++) {
      const pname = i === 0 ? spec.customer.name : `${pickOne(FIRST)} ${spec.customer.name.split(' ')[1]}`;
      await conn.query('INSERT INTO booking_passengers (booking_id, name, age, gender, mobile, seat_id, fare, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [id, pname, 18 + Math.floor(rand() * 45), FIRST.indexOf(pname.split(' ')[0]) % 2 ? genders[1] : genders[0], i === 0 ? spec.customer.phone : null, seats[i].id, fare, spec.createdAt]);
      if (!['cancelled', 'no_show'].includes(spec.bookingStatus)) {
        await conn.query("INSERT INTO trip_seats (trip_id, seat_id, status, booking_id) VALUES (?, ?, 'BOOKED', ?)", [spec.trip.id, seats[i].id, id]);
      }
    }
    const paid = ['paid', 'refund_pending', 'refunded'].includes(spec.paymentStatus);
    await conn.query(
      `INSERT INTO payments (booking_id, payment_method, payment_status, amount, upi_reference, transaction_reference, payment_date, verified_by, verified_at, remarks, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, spec.method, spec.paymentStatus, total,
        spec.method === 'UPI_QR' ? (spec.upiRef || `DEMO${String(400000000000 + id * 7919).slice(0, 12)}`) : null,
        paid && spec.method === 'CASH' ? `CASH-RCPT-${1000 + id}` : null,
        paid || spec.paymentStatus === 'verification_pending' ? (spec.paidAt || spec.createdAt) : null,
        paid ? adminId : null, paid ? (spec.paidAt || spec.createdAt) : null,
        spec.bookingStatus === 'cancelled' ? 'Booking cancelled (demo)' : null, spec.createdAt]
    );
    if (spec.paymentStatus === 'verification_pending') {
      await conn.query('INSERT INTO notifications (type, title, message, link, created_at) VALUES (?, ?, ?, ?, ?)',
        ['payment_verification', `UPI payment to verify: ${number}`, `${spec.customer.name} · ${boarding.stop_name} → ${dropping.stop_name} · ₹${total}`, '/admin/payments?status=verification_pending', spec.createdAt]);
    }
    return { id, number };
  };

  const now = nowIST();
  const at = (date, hh, mm) => `${date} ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00`;
  const nowMinus = (mins) => {
    const d = new Date(Date.parse(now.replace(' ', 'T') + 'Z') - mins * 60000);
    return d.toISOString().slice(0, 19).replace('T', ' ');
  };

  // Named demo customers and bookings from the brief (journey 7 days ahead)
  const rahul = await makeCustomer('Rahul Patil', 'rahul.demo@example.com', '9000000011', true);
  const amit = await makeCustomer('Amit Shinde', 'amit.demo@example.com', '9000000012', true);
  const sneha = await makeCustomer('Sneha Jadhav', 'sneha.demo@example.com', '9000000013', true);
  const [kol] = await tripsFor('pune-to-kolhapur', day(7), '06:00');
  const [mum] = await tripsFor('pune-to-mumbai', day(7), '07:30');
  const [nsk] = await tripsFor('pune-to-nashik', day(7), '08:00');
  const named = [
    await insertBooking({ trip: kol, customer: rahul, seatNumbers: ['05'], method: 'UPI_QR', bookingStatus: 'pending', paymentStatus: 'verification_pending', createdAt: nowMinus(95), upiRef: '426815903311' }),
    await insertBooking({ trip: mum, customer: amit, seatNumbers: ['L12'], method: 'CASH', bookingStatus: 'reserved', paymentStatus: 'pending', createdAt: nowMinus(80) }),
    await insertBooking({ trip: nsk, customer: sneha, seatNumbers: ['08'], method: 'UPI_QR', bookingStatus: 'confirmed', paymentStatus: 'paid', createdAt: nowMinus(70), paidAt: nowMinus(40), upiRef: '426815904472' }),
  ];
  log(`named demo bookings: ${named.map(b => b?.number).join(', ')}`);

  // Generated fictional customers
  const customers = [];
  for (let i = 0; i < 24; i++) {
    const name = `${FIRST[i % FIRST.length]} ${LAST[(i * 3) % LAST.length]}`;
    customers.push(await makeCustomer(name, `${name.split(' ')[0].toLowerCase()}.${name.split(' ')[1].toLowerCase()}${i}@example.com`, `90000002${String(i).padStart(2, '0')}`));
  }

  // Bookings created over the last 13 days (and today) on past and upcoming trips
  const slugs = ROUTES.map(r => r.slug);
  let count = 0;
  for (let back = 13; back >= 0; back--) {
    const created = day(-back);
    const perDay = back === 0 ? 9 : 2 + Math.floor(rand() * 3);
    for (let k = 0; k < perDay; k++) {
      const slug = pickOne(slugs);
      const travelOffset = -back + Math.floor(rand() * 6); // travel 0-5 days after booking
      const travelDate = day(travelOffset);
      const trips = await tripsFor(slug, travelDate);
      if (!trips.length) continue;
      const trip = pickOne(trips);
      const stopCount = (await getRouteStops(trip.route_id, { conn })).length;
      const segment = rand() < 0.75 ? [0, stopCount - 1] : (() => { const a = Math.floor(rand() * (stopCount - 1)); return [a, a + 1 + Math.floor(rand() * (stopCount - 1 - a))]; })();
      const method = rand() < 0.55 ? 'UPI_QR' : 'CASH';
      const createdAt = back === 0
        ? nowMinus(30 + Math.floor(rand() * 300))
        : at(created, 7 + Math.floor(rand() * 13), Math.floor(rand() * 60));
      const past = travelDate < TODAY;
      const r = rand();
      let bookingStatus; let paymentStatus; let paidAt = null;
      if (past) {
        if (r < 0.8) { bookingStatus = 'completed'; paymentStatus = 'paid'; paidAt = createdAt; }
        else if (r < 0.9) { bookingStatus = 'cancelled'; paymentStatus = method === 'UPI_QR' ? 'refunded' : 'not_applicable'; }
        else { bookingStatus = 'no_show'; paymentStatus = 'not_applicable'; }
      } else if (r < 0.5) { bookingStatus = 'confirmed'; paymentStatus = 'paid'; paidAt = back === 0 ? createdAt : at(created, 21, 0); }
      else if (r < 0.75) {
        bookingStatus = method === 'CASH' ? 'reserved' : 'pending';
        paymentStatus = method === 'CASH' ? 'pending' : 'verification_pending';
      } else if (r < 0.88) { bookingStatus = 'cancelled'; paymentStatus = method === 'UPI_QR' && rand() < 0.5 ? 'refund_pending' : 'not_applicable'; }
      else { bookingStatus = 'confirmed'; paymentStatus = 'paid'; paidAt = createdAt; }
      if (paidAt && paidAt > now) paidAt = now;

      const b = await insertBooking({
        trip, customer: pickOne(customers), count: 1 + Math.floor(rand() * 3), segment, method,
        bookingStatus, paymentStatus, createdAt, paidAt, source: rand() < 0.2 ? 'admin' : 'website',
      });
      if (b) count++;
    }
  }
  log(`${count} generated demo bookings across ${customers.length + 3} fictional customers${hash ? ' (named demo customers can log in with SEED_CUSTOMER_PASSWORD)' : ''}`);

  await conn.query("INSERT INTO audit_logs (user_type, action, module, new_values) VALUES ('system', 'seed.demo_data', 'system', ?)",
    [JSON.stringify({ bookings: count + named.length, seeded_at: now })]);
};

// ------------------------------------------------------------------ run

(async () => {
  console.log(`Seeding Ganraj Traveling demo data (today = ${TODAY})`);
  await withTransaction(async (conn) => {
    const adminId = await seedAdmin(conn);
    await seedSettings(conn);
    const loc = await seedLocations(conn);
    const vehicleIds = await seedFleet(conn);
    const routeIds = await seedRoutes(conn, loc);
    await seedSchedulesAndTrips(conn, routeIds, vehicleIds, adminId);
    await seedPaymentSettings(conn);
    await seedBookings(conn, adminId);
  });
  console.log('✓ Seed complete');
  await pool.end();
})().catch(async (err) => {
  console.error('Seed failed:', err.message);
  console.error(err.stack);
  await pool.end();
  process.exit(1);
});
