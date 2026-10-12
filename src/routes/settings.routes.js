const router = require('express').Router();
const { pool } = require('../config/database');
const { success, error } = require('../utils/response');
const { verifyAdmin, requirePermission } = require('../middleware/auth');
const { audit } = require('../services/audit.service');

const PUBLIC_KEYS = ['company_name', 'company_tagline', 'company_phone', 'company_email', 'company_address', 'company_city',
  'currency_symbol', 'whatsapp_number', 'social_facebook', 'social_instagram', 'social_twitter', 'meta_title_suffix',
  'homepage_seo_title', 'homepage_meta_desc', 'opening_hours', 'homepage_reviews', 'support_hours'];

const parse = (r) => {
  if (r.type === 'json') { try { return JSON.parse(r.value || 'null'); } catch { return null; } }
  if (r.type === 'number') return Number(r.value);
  if (r.type === 'boolean') return r.value === '1' || r.value === 'true';
  return r.value;
};

router.get('/public', async (req, res, next) => {
  try {
    const [rows] = await pool.query(`SELECT \`key\`, value, type FROM settings WHERE \`key\` IN (?)`, [PUBLIC_KEYS]);
    const obj = {};
    rows.forEach(r => { obj[r.key] = parse(r); });
    return success(res, obj);
  } catch(err) { next(err); }
});

router.get('/', verifyAdmin, requirePermission('settings.manage'), async (req, res, next) => {
  try {
    const { group } = req.query;
    const cond = group ? 'WHERE group_name = ?' : '';
    const [rows] = await pool.query(`SELECT \`key\`, value, type, group_name, label, description FROM settings ${cond} ORDER BY group_name, id`, group ? [group] : []);
    return success(res, rows);
  } catch(err) { next(err); }
});

router.put('/', verifyAdmin, requirePermission('settings.manage'), async (req, res, next) => {
  try {
    const { settings } = req.body;
    if (!Array.isArray(settings) || !settings.length) return error(res, 'Nothing to update', 400);
    const [current] = await pool.query('SELECT `key`, value, type FROM settings WHERE `key` IN (?)', [settings.map(s => String(s.key))]);
    const byKey = new Map(current.map(r => [r.key, r]));
    const oldValues = {}; const newValues = {};
    for (const s of settings) {
      const row = byKey.get(String(s.key));
      if (!row) return error(res, `Unknown setting: ${s.key}`, 400);
      const value = s.value === null || s.value === undefined ? '' : (typeof s.value === 'object' ? JSON.stringify(s.value) : String(s.value));
      if (row.type === 'json') { try { JSON.parse(value || 'null'); } catch { return error(res, `${s.key} must be valid JSON`, 400); } }
      if (row.type === 'number' && value !== '' && !Number.isFinite(Number(value))) return error(res, `${s.key} must be a number`, 400);
      if (value === row.value) continue;
      await pool.query('UPDATE settings SET value = ?, updated_by = ? WHERE `key` = ?', [value, req.user.id, s.key]);
      oldValues[s.key] = row.value; newValues[s.key] = value;
    }
    if (Object.keys(newValues).length) await audit(req, { action: 'settings.update', module: 'settings', oldValues, newValues });
    return success(res, null, Object.keys(newValues).length ? 'Settings saved' : 'No changes');
  } catch(err) { next(err); }
});

module.exports = router;
