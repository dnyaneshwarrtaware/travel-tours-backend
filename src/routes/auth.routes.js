const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const { body } = require('express-validator');
const ctrl = require('../controllers/auth.controller');
const validate = require('../middleware/validate');
const { verifyAdmin, verifyCustomer } = require('../middleware/auth');

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false,
  message: { success: false, message: 'Too many login attempts. Please try again later.' },
});

router.post('/admin/login', authLimiter, ctrl.adminLogin);
router.post('/refresh', ctrl.refreshToken);
router.get('/me', verifyAdmin, ctrl.getProfile);

// Customer accounts
router.post('/register', authLimiter, validate([
  body('name').trim().isLength({ min: 2, max: 150 }).withMessage('Please enter your name'),
  body('email').trim().isEmail().withMessage('Please enter a valid email'),
  body('phone').trim().customSanitizer(v => String(v).replace(/[\s-]/g, '').replace(/^(\+91|91)(?=\d{10}$)/, ''))
    .matches(/^[6-9]\d{9}$/).withMessage('Please enter a valid 10-digit mobile number'),
  body('password').isLength({ min: 8, max: 100 }).withMessage('Password must be at least 8 characters'),
]), ctrl.customerRegister);
router.post('/login', authLimiter, validate([
  body('email').trim().isEmail().withMessage('Please enter a valid email'),
  body('password').notEmpty().withMessage('Please enter your password'),
]), ctrl.customerLogin);
router.get('/customer/me', verifyCustomer, ctrl.customerProfile);

module.exports = router;
