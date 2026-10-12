// Small helpers shared by the admin routers

const pagination = (query, defaultLimit = 20, maxLimit = 200) => {
  const page = Math.max(1, parseInt(query.page) || 1);
  const limit = Math.min(maxLimit, Math.max(1, parseInt(query.limit) || defaultLimit));
  return { page, limit, offset: (page - 1) * limit };
};

const toFlag = (v) => (v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0);

// Keeps only defined keys from `allowed`
const pick = (obj, allowed) => {
  const out = {};
  allowed.forEach(k => { if (obj[k] !== undefined) out[k] = obj[k]; });
  return out;
};

// Builds "a = ?, b = ?" + values for an UPDATE from an object
const updateClause = (fields) => {
  const keys = Object.keys(fields);
  return { sql: keys.map(k => `\`${k}\` = ?`).join(', '), values: keys.map(k => fields[k]) };
};

// Only the keys whose values actually changed (for audit logs)
const diff = (before, after) => {
  const oldV = {}; const newV = {};
  Object.keys(after).forEach(k => {
    if (String(before?.[k] ?? '') !== String(after[k] ?? '')) { oldV[k] = before?.[k] ?? null; newV[k] = after[k]; }
  });
  return { oldValues: oldV, newValues: newV, changed: Object.keys(newV).length > 0 };
};

module.exports = { pagination, toFlag, pick, updateClause, diff };
