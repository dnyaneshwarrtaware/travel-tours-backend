const logger = require('../utils/logger');

const SENSITIVE = /password|token|secret/i;
const redact = (body) => (body && typeof body === 'object'
  ? Object.fromEntries(Object.entries(body).map(([k, v]) => [k, SENSITIVE.test(k) ? '[redacted]' : v]))
  : body);

const errorHandler = (err, req, res, next) => {
  const status = err.statusCode || err.status || 500;
  // Expected business-rule errors (4xx) are logged briefly; real failures with stack
  if (status >= 500) {
    logger.error(`${err.message} | ${req.method} ${req.originalUrl}`, { stack: err.stack, body: redact(req.body) });
  } else {
    logger.warn(`${status} ${err.message} | ${req.method} ${req.originalUrl}`);
  }

  // MySQL errors
  if (err.code === 'ER_DUP_ENTRY') {
    return res.status(409).json({
      success: false,
      message: 'A record with this information already exists.',
      data: null,
    });
  }

  if (err.code === 'ER_NO_REFERENCED_ROW_2') {
    return res.status(400).json({
      success: false,
      message: 'Referenced record does not exist.',
      data: null,
    });
  }

  // Validation errors
  if (err.type === 'validation') {
    return res.status(422).json({
      success: false,
      message: err.message || 'Validation failed',
      errors: err.errors || [],
      data: null,
    });
  }

  // Malformed JSON body
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ success: false, message: 'Invalid request body', data: null });
  }

  // Multer upload errors
  if (err.name === 'MulterError') {
    return res.status(400).json({ success: false, message: err.message, data: null });
  }

  // Default
  const statusCode = err.statusCode || err.status || 500;
  const message = process.env.NODE_ENV === 'production' && statusCode === 500
    ? 'Something went wrong. Please try again.'
    : err.message || 'Internal server error';

  res.status(statusCode).json({
    success: false,
    message,
    data: err.data || null,
  });
};

module.exports = errorHandler;
