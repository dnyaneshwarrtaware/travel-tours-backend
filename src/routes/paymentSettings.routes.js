const router = require('express').Router();
const { success } = require('../utils/response');
const { getActivePaymentOptions } = require('../services/payments/payment.service');

// GET /api/payment-settings - active Phase-1 payment options for checkout
router.get('/', async (req, res, next) => {
  try { return success(res, await getActivePaymentOptions()); } catch (err) { next(err); }
});

module.exports = router;
