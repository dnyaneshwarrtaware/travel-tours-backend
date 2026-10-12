const router = require('express').Router();
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { body, param } = require('express-validator');
const validate = require('../../middleware/validate');
const { pool } = require('../../config/database');
const { success, error } = require('../../utils/response');
const { diff } = require('../../utils/admin');
const { audit } = require('../../services/audit.service');
const { PROVIDERS } = require('../../services/payments/providers');

const PHASE1_METHODS = Object.keys(PROVIDERS); // CASH, UPI_QR
const UPI_RE = /^[a-zA-Z0-9._-]{2,256}@[a-zA-Z]{2,64}$/;
const QR_DIR = path.join(__dirname, '../../../uploads/payment');
fs.mkdirSync(QR_DIR, { recursive: true });

// Allowed image types: extension, declared MIME type and file signature must all agree
const IMAGE_TYPES = {
  '.png': { mime: ['image/png'], sig: (b) => b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  '.jpg': { mime: ['image/jpeg'], sig: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  '.jpeg': { mime: ['image/jpeg'], sig: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  '.webp': { mime: ['image/webp'], sig: (b) => b.slice(0, 4).toString('ascii') === 'RIFF' && b.slice(8, 12).toString('ascii') === 'WEBP' },
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: (parseInt(process.env.QR_MAX_FILE_SIZE_MB) || 2) * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const type = IMAGE_TYPES[ext];
    if (!type || !type.mime.includes(file.mimetype)) return cb(Object.assign(new Error('QR code must be a PNG, JPG, JPEG or WEBP image'), { statusCode: 400 }));
    cb(null, true);
  },
});

const methodParam = param('method').isIn(PHASE1_METHODS).withMessage('Unknown payment method');

router.get('/', async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT ps.*, u.name AS updated_by_name FROM payment_settings ps LEFT JOIN users u ON u.id = ps.updated_by
       WHERE ps.payment_method IN (?) ORDER BY FIELD(ps.payment_method, 'UPI_QR', 'CASH')`, [PHASE1_METHODS]
    );
    return success(res, rows);
  } catch (err) { next(err); }
});

// PUT /api/admin/payment-settings/:method
router.put('/:method', validate([
  methodParam,
  body('display_name').optional().trim().isLength({ min: 2, max: 150 }).withMessage('Display name is required'),
  body('upi_id').optional({ values: 'falsy' }).trim().matches(UPI_RE).withMessage('Enter a valid UPI ID, e.g. ganrajtraveling@upi'),
  body('instructions').optional({ nullable: true }).isString().isLength({ max: 1000 }),
  body('status').optional().isIn(['ACTIVE', 'INACTIVE']).withMessage('Invalid status'),
]), async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT * FROM payment_settings WHERE payment_method = ?', [req.params.method]);
    if (!rows.length) return error(res, 'Payment setting not found', 404);
    const current = rows[0];
    const data = {};
    ['display_name', 'instructions', 'status'].forEach(k => { if (req.body[k] !== undefined) data[k] = req.body[k]; });
    if (req.params.method === 'UPI_QR' && req.body.upi_id !== undefined) data.upi_id = req.body.upi_id || null;

    const merged = { ...current, ...data };
    if (req.params.method === 'UPI_QR' && merged.status === 'ACTIVE' && (!merged.upi_id || !merged.qr_image)) {
      return error(res, 'Upload a QR code and enter the UPI ID before activating UPI payments', 400);
    }
    const { oldValues, newValues, changed } = diff(current, data);
    if (!changed) return success(res, current, 'No changes');
    await pool.query('UPDATE payment_settings SET ?, updated_by = ? WHERE id = ?', [data, req.user.id, current.id]);
    await audit(req, { action: 'payment_settings.update', module: 'payment_settings', recordId: current.id, oldValues, newValues });
    const [[updated]] = await pool.query('SELECT * FROM payment_settings WHERE id = ?', [current.id]);
    return success(res, updated, 'Payment settings saved');
  } catch (err) { next(err); }
});

// POST /api/admin/payment-settings/UPI_QR/qr  (multipart field: "qr")
router.post('/:method/qr', validate([param('method').equals('UPI_QR').withMessage('QR images are only used for UPI payments')]),
  (req, res, next) => upload.single('qr')(req, res, (err) => {
    if (err?.code === 'LIMIT_FILE_SIZE') return error(res, `QR image must be under ${parseInt(process.env.QR_MAX_FILE_SIZE_MB) || 2} MB`, 400);
    return err ? next(err) : next();
  }),
  async (req, res, next) => {
    try {
      if (!req.file) return error(res, 'Choose a QR image to upload', 400);
      const ext = path.extname(req.file.originalname).toLowerCase();
      if (!IMAGE_TYPES[ext].sig(req.file.buffer)) return error(res, 'The file content is not a valid image', 400);

      const filename = `upi-qr-${uuidv4()}${ext === '.jpeg' ? '.jpg' : ext}`;
      await fs.promises.writeFile(path.join(QR_DIR, filename), req.file.buffer, { flag: 'wx' });
      const url = `/uploads/payment/${filename}`;

      const [[current]] = await pool.query("SELECT * FROM payment_settings WHERE payment_method = 'UPI_QR'");
      await pool.query('UPDATE payment_settings SET qr_image = ?, updated_by = ? WHERE id = ?', [url, req.user.id, current.id]);
      // Remove the replaced file (only files previously created by this upload endpoint)
      if (current.qr_image && /^\/uploads\/payment\/upi-qr-[0-9a-f-]+\.(png|jpg|webp)$/.test(current.qr_image)) {
        fs.promises.unlink(path.join(QR_DIR, path.basename(current.qr_image))).catch(() => {});
      }
      await audit(req, { action: current.qr_image ? 'payment_settings.qr.replace' : 'payment_settings.qr.upload', module: 'payment_settings', recordId: current.id, oldValues: { qr_image: current.qr_image }, newValues: { qr_image: url } });
      return success(res, { qr_image: url }, 'QR code uploaded');
    } catch (err) { next(err); }
  });

module.exports = router;
