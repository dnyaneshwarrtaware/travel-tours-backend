const success = (res, data = null, message = 'Request successful', statusCode = 200) => {
  return res.status(statusCode).json({ success: true, message, data });
};

const error = (res, message = 'Something went wrong', statusCode = 500, data = null) => {
  return res.status(statusCode).json({ success: false, message, data });
};

const paginated = (res, data, meta, message = 'Request successful') => {
  return res.status(200).json({ success: true, message, data, meta });
};

const buildPaginationMeta = (total, page, limit) => ({
  total,
  page: parseInt(page),
  limit: parseInt(limit),
  totalPages: Math.ceil(total / limit),
  hasNext: page * limit < total,
  hasPrev: page > 1,
});

module.exports = { success, error, paginated, buildPaginationMeta };
