require('dotenv').config({ quiet: true });
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { Pool } = require('pg');
const assert = require('node:assert/strict');

if (process.env.NODE_ENV === 'production') throw new Error('Esta prueba solo puede ejecutarse en desarrollo.');
const database = `postea_test_${crypto.randomBytes(5).toString('hex')}`;
const adminUrl = new URL(process.env.DATABASE_URL);
adminUrl.pathname = '/postgres';
const testUrl = new URL(process.env.DATABASE_URL);
testUrl.pathname = `/${database}`;
const admin = new Pool({ connectionString: adminUrl.toString(), max: 1 });

async function main() {
  let created = false;
  try {
    await admin.query(`CREATE DATABASE ${database}`);
    created = true;
    for (let run = 0; run < 2; run++) {
      const migrated = spawnSync(process.execPath, ['scripts/migrate.js'], {
        cwd: require('node:path').join(__dirname, '..'),
        env: { ...process.env, DATABASE_URL: testUrl.toString() }, encoding: 'utf8'
      });
      if (migrated.status !== 0) throw new Error(migrated.error?.message || migrated.stderr || migrated.stdout || `Proceso terminó con ${migrated.status}/${migrated.signal}`);
    }
    const test = new Pool({ connectionString: testUrl.toString(), max: 1 });
    try {
      const counts = await Promise.all(['schema_migrations', 'facultades', 'territorios', 'programas', 'usuarios']
        .map(table => test.query(`SELECT count(*)::int AS n FROM ${table}`)));
      assert.deepEqual(counts.map(result => result.rows[0].n), [3, 3, 5, 0, 0]);
      console.log('Migraciones desde base vacía e idempotencia: correctas.');
    } finally { await test.end(); }
  } finally {
    if (created) await admin.query(`DROP DATABASE ${database}`);
    await admin.end();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
