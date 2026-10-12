/**
 * Payment providers (Phase 1).
 *
 * Each provider decides the initial payment/booking status when a booking is
 * created, and which admin actions are valid for its payments.
 *
 * Active in Phase 1:
 *   CASH    - collected offline; admin marks it paid.
 *   UPI_QR  - customer pays to the configured UPI QR and taps "I Have Paid";
 *             an admin must verify it. It is NEVER marked paid automatically.
 *
 * Phase 2 (not implemented): an online gateway such as Razorpay is added by
 * registering a provider here (e.g. RAZORPAY with initiate() creating a gateway
 * order and a webhook/verify step setting the status). The payments table and
 * payment_method enum already reserve RAZORPAY, CARD, UPI_GATEWAY, NET_BANKING.
 */

const CashPaymentProvider = {
  method: 'CASH',
  label: 'Cash',
  // markPaidNow is only honoured for admin counter bookings
  initiate: ({ markPaidNow = false } = {}) => (markPaidNow
    ? { payment_status: 'paid', booking_status: 'confirmed', payment_date: true }
    : { payment_status: 'pending', booking_status: 'reserved' }),
  actions: {
    mark_paid: ['pending', 'failed'],
    reject: ['pending'],
  },
};

const QRCodePaymentProvider = {
  method: 'UPI_QR',
  label: 'UPI QR',
  initiate: ({ markPaidNow = false } = {}) => (markPaidNow
    ? { payment_status: 'paid', booking_status: 'confirmed', payment_date: true }
    : { payment_status: 'verification_pending', booking_status: 'pending', payment_date: true }),
  actions: {
    verify: ['verification_pending', 'failed'],
    reject: ['verification_pending'],
  },
};

const PROVIDERS = {
  [CashPaymentProvider.method]: CashPaymentProvider,
  [QRCodePaymentProvider.method]: QRCodePaymentProvider,
};

const getProvider = (method) => PROVIDERS[method] || null;

module.exports = { PROVIDERS, getProvider };
