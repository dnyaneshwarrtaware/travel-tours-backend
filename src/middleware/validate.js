const { validationResult } = require('express-validator');

// Runs express-validator chains and responds 422 with field errors on failure.
const validate = (chains) => [
  ...chains,
  (req, res, next) => {
    const result = validationResult(req);
    if (result.isEmpty()) return next();
    const errors = result.array().map(e => ({ field: e.path, message: e.msg }));
    return res.status(422).json({ success: false, message: errors[0].message, errors, data: null });
  },
];

module.exports = validate;
