const router = require('express').Router();
const ctrl = require('../controllers/route.controller');
const { verifyAdmin, requirePermission } = require('../middleware/auth');
const adminRoutes = require('./admin/routes');

// Public
router.get('/', ctrl.getRoutes);
router.get('/search', ctrl.searchRoutes);
router.get('/:slug', ctrl.getRouteBySlug);

// Admin protected (same handlers as /api/admin/routes - validated and audited)
const canManage = [verifyAdmin, requirePermission('routes.manage')];
router.post('/', ...canManage, ...adminRoutes.handlers.create);
router.put('/:id', ...canManage, ...adminRoutes.handlers.update);
router.delete('/:id', ...canManage, ...adminRoutes.handlers.remove);

module.exports = router;
