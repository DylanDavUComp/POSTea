const fs = require('node:fs/promises');
const path = require('node:path');
const { pool } = require('../src/db');

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(741266)');
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const dir = path.join(__dirname, '..', 'migrations');
    const files = (await fs.readdir(dir)).filter((name) => /^\d+_.*\.sql$/.test(name)).sort();
    for (const file of files) {
      const exists = await client.query('SELECT 1 FROM schema_migrations WHERE name = $1', [file]);
      if (exists.rowCount) continue;
      await client.query(await fs.readFile(path.join(dir, file), 'utf8'));
      await client.query('INSERT INTO schema_migrations(name) VALUES ($1)', [file]);
      console.log(`Aplicada: ${file}`);
    }
    await client.query('COMMIT');
    console.log('Migraciones al día.');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

// Destino sin contraseña, para distinguir un fallo de conexión de un error del esquema.
function target() {
  try {
    const url = new URL(process.env.DATABASE_URL);
    return `${url.hostname}:${url.port || 5432}${url.pathname}`;
  } catch { return 'DATABASE_URL inválida'; }
}

migrate()
  .catch((error) => {
    console.error(`Error al migrar (${target()}): ${error.message || error.code || error}`);
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
