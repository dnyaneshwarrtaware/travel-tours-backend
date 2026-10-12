const router = require('express').Router();
const multer = require('multer');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { success, error } = require('../utils/response');
const { verifyAdmin, requirePermission } = require('../middleware/auth');

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, '../../uploads')),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${uuidv4()}${ext}`);
  },
});

const fileFilter = (req, file, cb) => {
  const allowed = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
  const ext = path.extname(file.originalname).toLowerCase();
  if (allowed.includes(ext)) cb(null, true);
  else cb(new Error('Only image files allowed'), false);
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: (parseInt(process.env.MAX_FILE_SIZE_MB) || 5) * 1024 * 1024 },
});

router.post('/image', verifyAdmin, requirePermission('content.manage'), upload.single('image'), (req, res) => {
  if (!req.file) return error(res, 'No file uploaded', 400);
  const url = `/uploads/${req.file.filename}`;
  return success(res, { url, filename: req.file.filename }, 'Image uploaded');
});

router.post('/images', verifyAdmin, requirePermission('content.manage'), upload.array('images', 10), (req, res) => {
  if (!req.files?.length) return error(res, 'No files uploaded', 400);
  const urls = req.files.map(f => ({ url: `/uploads/${f.filename}`, filename: f.filename }));
  return success(res, urls, 'Images uploaded');
});

module.exports = router;
