// Error with an HTTP status code, understood by middleware/errorHandler.js
const httpError = (statusCode, message, data = null) =>
  Object.assign(new Error(message), { statusCode, data });

module.exports = httpError;
