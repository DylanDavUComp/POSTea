// Exportaciones por partes: se leen lotes de la base y se escriben a la respuesta a medida que llegan.
// Antes se armaba todo en memoria (respaldo de 150 fichas: 215 MB y pico de 512 MB en el contenedor de Render).
const { pool } = require('./db');
const { csvLine, BOM } = require('./csv');
const { ZipWriter, waitDrain } = require('./zip');

// Recorre una consulta por lotes ordenados por `id` (paginación por clave, sin OFFSET).
async function* batches(sql, size = 2000) {
  let last = 0;
  for (;;) {
    const rows = (await pool.query(`SELECT * FROM (${sql}) q WHERE q.id > $1 ORDER BY q.id LIMIT ${size}`, [last])).rows;
    if (!rows.length) return;
    yield rows;
    last = rows[rows.length - 1].id;
    if (rows.length < size) return;
  }
}

// Escribe en un stream respetando la contrapresión (cliente lento = la app espera, no acumula).
const writer = out => async chunk => { if (out.destroyed) throw new Error('La descarga se interrumpió.'); if (!out.write(chunk)) await waitDrain(out); };
// Acumula en memoria: solo para archivos medianos que van dentro del ZIP.
function collector() {
  const parts = [];
  const emit = async chunk => { parts.push(Buffer.from(chunk, 'utf8')); };
  return { emit, buffer: () => Buffer.concat(parts) };
}

async function writeCsv(emit, sql) {
  await emit(BOM);
  let columns = null;
  for await (const rows of batches(sql)) {
    if (!columns) { columns = Object.keys(rows[0]); await emit(csvLine(columns)); }
    await emit(rows.map(row => csvLine(columns.map(c => row[c]))).join(''));
  }
  if (!columns) await emit('\r\n'); // Igual que antes: tabla vacía = archivo con BOM y línea vacía.
}

// Respaldo completo: todas las tablas tal cual (sin contraseñas, sesiones ni tokens).
const BACKUP_TABLES = ['facultades', 'programas', 'territorios', 'usuarios', 'coordinadores_programa', 'investigaciones', 'investigadores',
  'inversiones', 'comentarios', 'reportes_comentario', 'visitas', 'configuracion', 'schema_migrations'];
const KEYED = new Set(['facultades', 'programas', 'territorios', 'usuarios', 'investigaciones', 'investigadores', 'inversiones', 'comentarios', 'visitas']);
const IMAGE_COLUMNS = ['imagen', 'cambios_imagen'];

// images: 'inline' (base64 dentro del JSON), 'files' (ruta al archivo dentro del ZIP) o 'none'.
async function writeBackupJson(emit, { images = 'inline', baseUrl = '' } = {}) {
  await emit(`{"generado_at":${JSON.stringify(new Date().toISOString())},"base_url":${JSON.stringify(baseUrl)},"tablas":{`);
  for (const [index, table] of BACKUP_TABLES.entries()) {
    await emit(`${index ? ',' : ''}${JSON.stringify(table)}:[`);
    // Las fichas van de a 10 (imágenes de ~350 KB); el resto en lotes grandes.
    const source = KEYED.has(table) ? batches(`SELECT * FROM ${table}`, table === 'investigaciones' ? 10 : 2000)
      : (async function* () { yield (await pool.query(`SELECT * FROM ${table} ORDER BY 1`)).rows; })();
    let first = true;
    for await (const rows of source) {
      const json = rows.map(row => {
        const copy = { ...row };
        delete copy.password_hash;
        delete copy.imagen_mini; // Derivada de `imagen`: se regenera sola.
        if (table === 'investigaciones') for (const column of IMAGE_COLUMNS) {
          const suffix = column === 'imagen' ? '' : '-propuesta';
          copy[column] = !row[column] || images === 'none' ? null
            : images === 'files' ? `imagenes/${row.id}${suffix}.webp` : row[column].toString('base64');
        }
        return JSON.stringify(copy);
      });
      if (json.length) { await emit((first ? '' : ',') + json.join(',')); first = false; }
    }
    await emit(']');
  }
  await emit('}}');
}

async function sendBackupJson(res, options) {
  const emit = writer(res);
  await writeBackupJson(emit, options);
  res.end();
}

async function sendCsv(res, sql) {
  const emit = writer(res);
  await writeCsv(emit, sql);
  res.end();
}

// ZIP completo: un CSV por exportación, el respaldo JSON (con rutas a las imágenes) y cada imagen como archivo WebP,
// escritas de a una. En memoria solo hay un archivo a la vez.
async function sendExportZip(res, exports, options) {
  const zip = new ZipWriter(res);
  for (const [key, sql] of Object.entries(exports)) {
    const file = collector();
    await writeCsv(file.emit, sql);
    await zip.add(`${key}.csv`, file.buffer());
  }
  const json = collector();
  await writeBackupJson(json.emit, { ...options, images: 'files' });
  await zip.add('respaldo-completo.json', json.buffer());
  const ids = (await pool.query('SELECT id FROM investigaciones WHERE imagen IS NOT NULL OR cambios_imagen IS NOT NULL ORDER BY id')).rows;
  for (const { id } of ids) {
    const row = (await pool.query('SELECT imagen, cambios_imagen FROM investigaciones WHERE id=$1', [id])).rows[0];
    if (row?.imagen) await zip.add(`imagenes/${id}.webp`, row.imagen);
    if (row?.cambios_imagen) await zip.add(`imagenes/${id}-propuesta.webp`, row.cambios_imagen);
  }
  await zip.end();
}

// Una exportación pesada a la vez: dos respaldos simultáneos no deben competir por los 512 MB.
let running = false;
async function exclusive(res, fn) {
  if (running) {
    return res.status(429).set('Retry-After', '60').render('error', { title: 'Exportación en curso',
      message: 'Ya hay una exportación descargándose. Espera a que termine e inténtalo de nuevo.' });
  }
  running = true;
  try { await fn(); } catch (error) {
    // Si ya empezó la descarga no se puede mostrar una página de error: se corta para que el archivo quede
    // incompleto de forma evidente (el navegador marca la descarga como fallida) y no parezca válido.
    if (!res.headersSent) throw error;
    console.error('Exportación interrumpida:', error.message);
    res.destroy(error);
  } finally { running = false; }
}

module.exports = { batches, writeCsv, writeBackupJson, sendBackupJson, sendCsv, sendExportZip, exclusive, BACKUP_TABLES };
