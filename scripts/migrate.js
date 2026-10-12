/**
 * Database migration runner.
 *
 *   npm run db:migrate            apply pending migrations
 *   npm run db:migrate -- --status   list applied / pending migrations
 *
 * - Creates the database if it does not exist.
 * - On a fresh database, applies database/schema.sql as the "000_baseline" migration.
 * - Then applies database/migrations/*.sql in filename order, once each,
 *   recording them in the schema_migrations table.
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

const DB_DIR = path.join(__dirname, '../../database');
const MIGRATIONS_DIR = path.join(DB_DIR, 'migrations');
const dbName = process.env.DB_NAME || 'travel_tours_db';

if (!/^[A-Za-z0-9_]+$/.test(dbName)) {
  console.error('DB_NAME may only contain letters, digits and underscores');
  process.exit(1);
}

const connect = (database) => mysql.createConnection({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database,
  multipleStatements: true,
  timezone: '+05:30',
});

const run = async () => {
  const root = await connect();
  await root.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await root.end();

  const conn = await connect(dbName);
  await conn.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name VARCHAR(200) PRIMARY KEY,
    applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB`);

  const [appliedRows] = await conn.query('SELECT name FROM schema_migrations');
  const applied = new Set(appliedRows.map(r => r.name));

  const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();
  const all = [{ name: '000_baseline', file: path.join(DB_DIR, 'schema.sql') },
    ...files.map(f => ({ name: f.replace(/\.sql$/, ''), file: path.join(MIGRATIONS_DIR, f) }))];

  if (process.argv.includes('--status')) {
    all.forEach(m => console.log(`${applied.has(m.name) ? '[applied]' : '[pending]'} ${m.name}`));
    await conn.end();
    return;
  }

  // An existing database created from schema.sql by hand already has the baseline.
  if (!applied.has('000_baseline')) {
    const [[{ n }]] = await conn.query(
      "SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = ? AND table_name = 'roles'", [dbName]
    );
    if (n > 0) {
      await conn.query('INSERT INTO schema_migrations (name) VALUES (?)', ['000_baseline']);
      applied.add('000_baseline');
      console.log('• 000_baseline already present (existing schema detected)');
    }
  }

  let count = 0;
  for (const m of all) {
    if (applied.has(m.name)) continue;
    process.stdout.write(`→ applying ${m.name} ... `);
    const sql = fs.readFileSync(m.file, 'utf8');
    try {
      await conn.query(sql);
    } catch (err) {
      console.log('FAILED');
      console.error(err.message);
      console.error('Note: MySQL DDL is not transactional; fix the issue and restore/repair before re-running.');
      await conn.end();
      process.exit(1);
    }
    await conn.query('INSERT INTO schema_migrations (name) VALUES (?)', [m.name]);
    console.log('done');
    count++;
  }
  console.log(count ? `✓ ${count} migration(s) applied` : '✓ Database is up to date');
  await conn.end();
};

run().catch((err) => { console.error(err.message); process.exit(1); });
