const router = require('express').Router();
const ctrl = require('../controllers/admin.controller');
const { verifyAdmin, requirePermission: can } = require('../middleware/auth');

router.use(verifyAdmin);
router.get('/dashboard', can('dashboard.view'), ctrl.getDashboardStats);

// Travel management. Read access is shared by modules that need lookups
// (e.g. the trips screen lists routes and vehicles).
const travelRead = can('locations.manage', 'routes.manage', 'fares.manage', 'trips.manage', 'schedules.manage', 'vehicles.manage', 'bookings.manage', 'reports.view');
const readOr = (perm) => (req, res, next) => (req.method === 'GET' ? travelRead(req, res, next) : can(perm)(req, res, next));

router.use('/locations', readOr('locations.manage'), require('./admin/locations'));
router.use('/routes', can('routes.manage', 'fares.manage', 'trips.manage', 'schedules.manage', 'bookings.manage', 'reports.view'), require('./admin/routes'));
router.use('/operators', readOr('operators.manage'), require('./admin/operators'));
router.use('/vehicles', readOr('vehicles.manage'), require('./admin/vehicles'));
router.use('/seat-layouts', readOr('seat_layouts.manage'), require('./admin/seatLayouts'));
router.use('/trips', can('trips.manage', 'bookings.view', 'bookings.manage'), require('./admin/trips'));
router.use('/schedules', can('schedules.manage'), require('./admin/schedules'));

// Bookings & customers
router.use('/bookings', can('bookings.view', 'bookings.manage'), require('./admin/bookings'));
router.use('/customers', can('customers.view'), require('./admin/customers'));

// Payments
router.use('/payments', can('payments.view', 'payments.verify'), require('./admin/payments'));
router.use('/payment-settings', can('payment_settings.manage'), require('./admin/paymentSettings'));

// Reports & system
router.use('/reports', can('reports.view'), require('./admin/reports'));
router.use('/users', can('users.manage'), require('./admin/users'));
router.use('/roles', can('roles.manage', 'users.manage'), require('./admin/roles'));
router.use('/notifications', can('notifications.view'), require('./admin/notifications'));
router.use('/audit-logs', can('audit_logs.view'), require('./admin/auditLogs'));

module.exports = router;
