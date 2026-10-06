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
      const migrationFiles = require('node:fs').readdirSync(require('node:path').join(__dirname, '..', 'migrations')).filter(f => /^\d+_.*\.sql$/.test(f)).length;
      assert.deepEqual(counts.map(result => result.rows[0].n), [migrationFiles, 3, 5, 22, 0]);
      // Programas oficiales (migración 007): 8 de Ingeniería, 7 de Negocios y 7 de Ciencias Sociales; la segunda corrida no duplica.
      const byFaculty = (await test.query(`SELECT f.nombre, count(*)::int AS n FROM programas p JOIN facultades f ON f.id=p.facultad_id
        WHERE p.activo AND p.cupo=3 AND NOT p.es_especializacion GROUP BY f.nombre`)).rows;
      assert.deepEqual(Object.fromEntries(byFaculty.map(r => [r.nombre, r.n])),
        { 'Facultad de Ingeniería': 8, 'Escuela de Negocios': 7, 'Facultad de Ciencias Sociales y de la Educación': 7 });
      // La convocatoria abre el 6 de octubre (migración 008).
      assert.equal((await test.query("SELECT valor FROM configuracion WHERE clave='fecha_apertura'")).rows[0].valor, '2026-10-06');
      console.log('Migraciones desde base vacía e idempotencia: correctas.');
    } finally { await test.end(); }
  } finally {
    if (created) await admin.query(`DROP DATABASE ${database}`);
    await admin.end();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
