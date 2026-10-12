const { pool, withTransaction } = require('../../config/database');
const httpError = require('../../utils/httpError');
const { getProvider } = require('./providers');
const { audit } = require('../audit.service');
const { notify } = require('../notification.service');

const ACTION_LABELS = {
  verify: 'Verify payment',
  mark_paid: 'Mark paid',
  reject: 'Reject payment',
  refund: 'Mark refunded',
};

// Throws unless the method has an active payment setting and a Phase-1 provider
const assertMethodAvailable = async (conn, method) => {
  const provider = getProvider(method);
  if (!provider) throw httpError(400, 'This payment method is not available');
  const [rows] = await conn.query("SELECT status FROM payment_settings WHERE payment_method = ?", [method]);
  if (!rows.length || rows[0].status !== 'ACTIVE') throw httpError(400, `${provider.label} payment is currently unavailable`);
  return provider;
};

// Active payment options for checkout (only what the customer needs to see)
const getActivePaymentOptions = async () => {
  const [rows] = await pool.query(
    "SELECT payment_method, display_name, upi_id, qr_image, instructions FROM payment_settings WHERE status = 'ACTIVE' ORDER BY FIELD(payment_method, 'UPI_QR', 'CASH'), id"
  );
  return rows.filter(r => getProvider(r.payment_method)).filter(r => r.payment_method !== 'UPI_QR' || r.qr_image);
};

const loadForUpdate = async (conn, paymentId) => {
  const [rows] = await conn.query('SELECT * FROM payments WHERE id = ? FOR UPDATE', [paymentId]);
  if (!rows.length) throw httpError(404, 'Payment not found');
  const payment = rows[0];
  const [bRows] = await conn.query('SELECT * FROM bookings WHERE id = ? FOR UPDATE', [payment.booking_id]);
  return { payment, booking: bRows[0] };
};

/**
 * Admin payment actions: verify | mark_paid | reject | refund | update
 * `input`: { transaction_reference, remarks, amount }
 */
const applyPaymentAction = async (paymentId, action, input, req) => withTransaction(async (conn) => {
  const { payment, booking } = await loadForUpdate(conn, paymentId);
  const provider = getProvider(payment.payment_method);
  const before = { payment_status: payment.payment_status, booking_status: booking.booking_status, transaction_reference: payment.transaction_reference, remarks: payment.remarks };

  const reference = input.transaction_reference !== undefined ? String(input.transaction_reference || '').trim() || null : undefined;
  const remarks = input.remarks !== undefined ? String(input.remarks || '').trim() || null : undefined;
  const sets = [];
  const vals = [];
  if (reference !== undefined) { sets.push('transaction_reference = ?'); vals.push(reference); }
  if (remarks !== undefined) { sets.push('remarks = ?'); vals.push(remarks); }

  let newPaymentStatus = payment.payment_status;
  let newBookingStatus = booking.booking_status;

  if (action === 'update') {
    if (!sets.length) throw httpError(400, 'Nothing to update');
  } else if (action === 'refund') {
    if (payment.payment_status !== 'refund_pending') throw httpError(400, 'Only payments with a pending refund can be marked refunded');
    newPaymentStatus = 'refunded';
  } else {
    if (!provider || !provider.actions[action]) throw httpError(400, `${ACTION_LABELS[action] || action} is not valid for ${payment.payment_method} payments`);
    if (booking.booking_status === 'cancelled') throw httpError(400, 'Cancelled bookings cannot be paid or verified');
    if (!provider.actions[action].includes(payment.payment_status)) {
      throw httpError(400, `Cannot ${ACTION_LABELS[action].toLowerCase()} a payment that is ${payment.payment_status.replace('_', ' ')}`);
    }

    if (action === 'verify' || action === 'mark_paid') {
      if (input.amount !== undefined && input.amount !== null && input.amount !== '') {
        const amt = Number(input.amount);
        if (!Number.isFinite(amt) || Math.abs(amt - Number(payment.amount)) > 0.001 || Math.abs(amt - Number(booking.total_amount)) > 0.001) {
          throw httpError(400, `Amount received must match the booking amount of ₹${Number(booking.total_amount).toFixed(2)}`);
        }
      }
      if (Math.abs(Number(payment.amount) - Number(booking.total_amount)) > 0.001) {
        throw httpError(400, 'Payment amount does not match the booking amount');
      }
      newPaymentStatus = 'paid';
      if (['pending', 'reserved'].includes(booking.booking_status)) newBookingStatus = 'confirmed';
      sets.push('verified_by = ?', 'verified_at = NOW()', 'payment_date = COALESCE(payment_date, NOW())');
      vals.push(req.user.id);
    } else if (action === 'reject') {
      if (!remarks) throw httpError(400, 'Please add a remark explaining why the payment was rejected');
      newPaymentStatus = 'failed';
      sets.push('verified_by = ?', 'verified_at = NOW()');
      vals.push(req.user.id);
    }
  }

  if (newPaymentStatus !== payment.payment_status) { sets.push('payment_status = ?'); vals.push(newPaymentStatus); }
  if (sets.length) await conn.query(`UPDATE payments SET ${sets.join(', ')} WHERE id = ?`, [...vals, payment.id]);

  if (newPaymentStatus !== booking.payment_status || newBookingStatus !== booking.booking_status) {
    await conn.query('UPDATE bookings SET payment_status = ?, booking_status = ? WHERE id = ?', [newPaymentStatus, newBookingStatus, booking.id]);
  }

  const after = { payment_status: newPaymentStatus, booking_status: newBookingStatus, transaction_reference: reference !== undefined ? reference : payment.transaction_reference, remarks: remarks !== undefined ? remarks : payment.remarks };
  await audit(req, {
    action: action === 'update' ? 'payment.update' : `payment.${action}`,
    module: 'payments', recordId: payment.id, oldValues: { booking_number: booking.booking_number, ...before }, newValues: after,
  }, conn);

  if (action === 'reject') {
    await notify(conn, { type: 'payment_rejected', title: `Payment rejected for ${booking.booking_number}`, message: remarks, link: '/admin/payments' });
  }
  return { id: payment.id, booking_id: booking.id, booking_number: booking.booking_number, ...after };
});

module.exports = { assertMethodAvailable, getActivePaymentOptions, applyPaymentAction };
