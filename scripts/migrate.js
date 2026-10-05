const fs = require('node:fs/promises');
const path = require('node:path');
const { pool, isDbUnavailable } = require('../src/db');

// Al arrancar en Render la base puede no estar lista (mantenimiento, reinicio): se reintenta con espera progresiva
// (1, 2, 4, 8, 16 y luego 30 s) en vez de fallar de inmediato. Un error de SQL en una migración no se reintenta.
const RETRIES = Number(process.env.DB_CONNECT_RETRIES) || 10;
const BASE_DELAY_MS = Number(process.env.DB_RETRY_BASE_MS) || 1000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function migrate() {
  const client = await pool.connect();
  let failure;
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
    failure = error;
    // Todo va en una transacción: si la conexión se corta a mitad, PostgreSQL descarta lo aplicado y se puede reintentar.
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release(isDbUnavailable(failure) ? failure : undefined); // Una conexión rota no vuelve al pool.
  }
}

async function migrateWithRetry() {
  for (let attempt = 1; ; attempt++) {
    try { return await migrate(); } catch (error) {
      if (!isDbUnavailable(error) || attempt >= RETRIES) throw error;
      const wait = Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), 30 * BASE_DELAY_MS);
      console.warn(`La base no responde (${error.code || error.message}). Intento ${attempt}/${RETRIES}; reintento en ${(wait / 1000).toFixed(1)} s.`);
      await sleep(wait);
    }
  }
}

// Destino sin contraseña, para distinguir un fallo de conexión de un error del esquema.
function target() {
  try {
    const url = new URL(process.env.DATABASE_URL);
    return `${url.hostname}:${url.port || 5432}${url.pathname}`;
  } catch { return 'DATABASE_URL inválida'; }
}

migrateWithRetry()
  .catch((error) => {
    console.error(`Error al migrar (${target()}): ${error.message || error.code || error}`);
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
