// Operación en Render Free: exportaciones por partes (ZIP válido, imágenes de propuesta en base64), una exportación a la vez,
// variante pequeña de imágenes con ETag/304, compresión, /health (liveness) y /health/db, aviso de vencimiento y tamaño
// de la base, y URL de QR atada a la BASE_URL confirmada.
require('dotenv').config({ quiet: true });
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const sharp = require('sharp');
if (process.env.NODE_ENV === 'production') throw new Error('Prueba reservada a desarrollo.');
const app = require('../src/app');
const { pool } = require('../src/db');
const { crc32 } = require('../src/zip');
const { exclusive } = require('../src/exports');
const { dbExpiry } = require('../src/ops');
const { qrUrlProblem, baseUrlProblem } = require('../src/config');
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
const get = (path, options = {}) => fetch(base + path, { redirect: 'manual', ...options });
// Revalidación como la hace un navegador. `fetch` añade Cache-Control: no-cache a toda solicitud condicional
// (lo exige el estándar) y entonces el servidor responde completo; por eso aquí se usa node:http.
const revalidate = (path, etag) => new Promise((resolve, reject) => require('node:http')
  .get(base + path, { headers: { 'if-none-match': etag } }, res => { res.resume(); resolve(res.statusCode); }).on('error', reject));
const csrfOf = html => html.match(/name="_csrf" value="([a-f0-9]+)"/)[1];
const suffix = crypto.randomBytes(5).toString('hex');
const originalEnv = { BASE_URL: process.env.BASE_URL, DB_EXPIRA_EN: process.env.DB_EXPIRA_EN, DB_LIMITE_MB: process.env.DB_LIMITE_MB };
let program, author, research, draft, savedConfig;

async function login(email, password) {
  const page = await get('/ingresar');
  const cookie = page.headers.get('set-cookie').split(';')[0];
  const res = await get('/ingresar', { method: 'POST', headers: { cookie }, body: new URLSearchParams({ _csrf: csrfOf(await page.text()), email, password }) });
  assert.equal(res.status, 302, `ingreso de ${email}`);
  return res.headers.get('set-cookie').split(';')[0];
}

// Lee un ZIP: valida el directorio central, el CRC32 y el tamaño de cada archivo.
function unzip(buffer) {
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end >= 0, 'ZIP con registro final');
  const count = buffer.readUInt16LE(end + 10);
  let at = buffer.readUInt32LE(end + 16);
  const files = {};
  for (let i = 0; i < count; i++) {
    assert.equal(buffer.readUInt32LE(at), 0x02014b50, 'entrada del directorio central');
    const crc = buffer.readUInt32LE(at + 16), size = buffer.readUInt32LE(at + 20);
    const nameLength = buffer.readUInt16LE(at + 28), extra = buffer.readUInt16LE(at + 30), comment = buffer.readUInt16LE(at + 32);
    const local = buffer.readUInt32LE(at + 42), name = buffer.toString('utf8', at + 46, at + 46 + nameLength);
    assert.equal(buffer.readUInt32LE(local), 0x04034b50, `${name}: encabezado local`);
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const data = buffer.subarray(start, start + size);
    assert.equal(crc32(data), crc, `${name}: CRC32 correcto`);
    files[name] = data;
    at += 46 + nameLength + extra + comment;
  }
  return files;
}

async function main() {
  savedConfig = (await pool.query('SELECT clave,valor FROM configuracion')).rows;
  const territory = (await pool.query('SELECT id FROM territorios ORDER BY orden LIMIT 1')).rows[0].id;
  const faculty = (await pool.query('SELECT id FROM facultades ORDER BY orden LIMIT 1')).rows[0].id;
  program = (await pool.query('INSERT INTO programas(nombre,facultad_id) VALUES($1,$2) RETURNING id', [`DEMO operación ${suffix}`, faculty])).rows[0].id;
  author = (await pool.query(`INSERT INTO usuarios(nombre,email,password_hash,rol,tipo_persona,programa_id,acepta_datos_at,acepta_datos_version)
    VALUES('DEMO operación',$1,'x','autor','docente',$2,now(),'prueba') RETURNING id`, [`operacion-${suffix}@example.com`, program])).rows[0].id;
  const photo = color => sharp({ create: { width: 1600, height: 1200, channels: 3, background: color } }).webp({ quality: 80 }).toBuffer();
  const [image, proposal] = await Promise.all([photo({ r: 200, g: 80, b: 40 }), photo({ r: 40, g: 80, b: 200 })]);
  research = (await pool.query(`INSERT INTO investigaciones(slug,programa_id,territorio_id,autor_id,titulo,estado_investigacion,imagen,imagen_mime,
      derechos_imagen_confirmados,estado_flujo,publicada_at,edicion_autorizada_at,cambios,cambios_imagen,cambios_estado)
    VALUES($1,$2,$3,$4,'DEMO operación','terminada',$5,'image/webp',true,'publicada',now(),now(),'{"titulo":"DEMO cambio"}',$6,'enviada') RETURNING id`,
    [`demo-operacion-${suffix}`, program, territory, author, image, proposal])).rows[0].id;
  const admin = await login(process.env.ADMIN_EMAIL, process.env.ADMIN_PASSWORD);

  // /health es liveness (no toca la base); /health/db verifica la base.
  let res = await get('/health');
  assert.equal(res.status, 200); assert.equal(await res.text(), 'ok'); assert.equal(res.headers.get('cache-control'), 'no-store');
  res = await get('/health/db');
  assert.equal(res.status, 200); assert.equal(await res.text(), 'ok');

  // Compresión: HTML y CSS comprimidos; las exportaciones no (van por partes con contrapresión propia).
  res = await get('/', { headers: { 'accept-encoding': 'gzip' } });
  assert.equal(res.headers.get('content-encoding'), 'gzip', 'HTML con gzip');
  res = await get('/css/app.css', { headers: { 'accept-encoding': 'gzip' } });
  assert.equal(res.headers.get('content-encoding'), 'gzip', 'CSS con gzip');

  // Variante pequeña: se genera la primera vez (≤ 1080 px), se guarda, tiene ETag y responde 304 sin reenviar la imagen.
  res = await get(`/media/investigaciones/${research}/mini`);
  assert.equal(res.status, 200); assert.equal(res.headers.get('content-type'), 'image/webp');
  assert.equal(res.headers.get('cache-control'), 'public, max-age=300');
  const mini = Buffer.from(await res.arrayBuffer());
  const meta = await sharp(mini).metadata();
  assert.ok(meta.width <= 1080 && meta.height <= 1080, `mini de ${meta.width}×${meta.height}`);
  assert.ok(mini.length < image.length, 'la mini pesa menos que la original');
  const etag = res.headers.get('etag');
  assert.match(etag, /^"[a-f0-9]{32}-m"$/);
  assert.ok((await pool.query('SELECT imagen_mini IS NOT NULL AS ok FROM investigaciones WHERE id=$1', [research])).rows[0].ok, 'mini guardada');
  assert.equal(await revalidate(`/media/investigaciones/${research}/mini`, etag), 304, 'revalidación sin cuerpo');
  res = await get(`/media/investigaciones/${research}`);
  assert.notEqual(res.headers.get('etag'), etag, 'la original tiene otro ETag');
  assert.equal(Buffer.compare(Buffer.from(await res.arrayBuffer()), image), 0, 'la original no cambia');
  // Cambiar la imagen descarta la mini (trigger) y la siguiente solicitud la regenera.
  await pool.query('UPDATE investigaciones SET imagen=$1 WHERE id=$2', [proposal, research]);
  assert.equal((await pool.query('SELECT imagen_mini IS NULL AS vacia FROM investigaciones WHERE id=$1', [research])).rows[0].vacia, true);
  assert.equal(await revalidate(`/media/investigaciones/${research}/mini`, etag), 200, 'ETag viejo ya no vale');
  await pool.query('UPDATE investigaciones SET imagen=$1 WHERE id=$2', [image, research]);
  // Tarjetas y ficha piden la mini; la ficha ofrece la original para pantallas grandes.
  const fiche = await (await get(`/f/demo-operacion-${suffix}`)).text();
  assert.match(fiche, new RegExp(`srcset="/media/investigaciones/${research}/mini 1080w, /media/investigaciones/${research} 1600w"`));
  // Una ficha no publicada no expone su mini.
  draft = (await pool.query(`INSERT INTO investigaciones(slug,programa_id,autor_id,titulo,imagen,imagen_mime)
    VALUES($1,$2,$3,'DEMO borrador',$4,'image/webp') RETURNING id`, [`demo-borrador-${suffix}`, program, author, image])).rows[0].id;
  assert.equal((await get(`/media/investigaciones/${draft}/mini`)).status, 404);

  // Respaldo JSON por partes: imagen y propuesta en base64 (antes la propuesta salía como arreglo de números), sin la mini.
  res = await get('/admin/exportar/respaldo.json', { headers: { cookie: admin } });
  assert.equal(res.status, 200); assert.equal(res.headers.get('content-encoding'), null);
  const backup = JSON.parse(await res.text());
  const row = backup.tablas.investigaciones.find(i => String(i.id) === String(research));
  assert.equal(Buffer.compare(Buffer.from(row.imagen, 'base64'), image), 0, 'imagen en base64');
  assert.equal(Buffer.compare(Buffer.from(row.cambios_imagen, 'base64'), proposal), 0, 'propuesta en base64');
  assert.ok(!('imagen_mini' in row), 'la mini no va en el respaldo');
  assert.ok(backup.tablas.usuarios.every(u => !('password_hash' in u)));
  for (const table of ['facultades', 'configuracion', 'schema_migrations', 'visitas']) assert.ok(Array.isArray(backup.tablas[table]), `tabla ${table}`);
  const noImages = JSON.parse(await (await get('/admin/exportar/respaldo.json?imagenes=0', { headers: { cookie: admin } })).text());
  const bare = noImages.tablas.investigaciones.find(i => String(i.id) === String(research));
  assert.equal(bare.imagen, null); assert.equal(bare.cambios_imagen, null);

  // ZIP completo: CRC válido, CSV, JSON con rutas e imágenes como archivos WebP.
  const files = unzip(Buffer.from(await (await get('/admin/exportar/todo.zip', { headers: { cookie: admin } })).arrayBuffer()));
  for (const name of ['investigaciones.csv', 'usuarios.csv', 'visitas.csv', 'programas.csv', 'respaldo-completo.json']) assert.ok(files[name], `ZIP incluye ${name}`);
  assert.equal(Buffer.compare(files[`imagenes/${research}.webp`], image), 0, 'imagen en el ZIP');
  assert.equal(Buffer.compare(files[`imagenes/${research}-propuesta.webp`], proposal), 0, 'propuesta en el ZIP');
  const zipped = JSON.parse(files['respaldo-completo.json'].toString('utf8')).tablas.investigaciones.find(i => String(i.id) === String(research));
  assert.equal(zipped.imagen, `imagenes/${research}.webp`); assert.equal(zipped.cambios_imagen, `imagenes/${research}-propuesta.webp`);
  assert.match(files['investigaciones.csv'].toString('utf8'), new RegExp(`demo-operacion-${suffix}`), 'CSV por lotes completo');
  // El CSV por lotes trae todas las filas, igual que una consulta directa.
  const csvRows = files['visitas.csv'].toString('utf8').trim().split('\r\n').length - 1;
  assert.equal(csvRows, (await pool.query('SELECT count(*)::int AS n FROM visitas')).rows[0].n);

  // Una exportación pesada a la vez: la segunda recibe 429 mientras la primera sigue.
  const fakeRes = () => { const r = { headersSent: false, code: null, set() { return r; }, status(c) { r.code = c; return r; }, render() { return r; } }; return r; };
  let release; const first = exclusive(fakeRes(), () => new Promise(resolve => { release = resolve; }));
  const second = fakeRes(); await exclusive(second, async () => assert.fail('no debe correr'));
  assert.equal(second.code, 429); release(); await first;
  const third = fakeRes(); let ran = false; await exclusive(third, async () => { ran = true; }); assert.ok(ran, 'libera el turno al terminar');

  // Vencimiento de la base (DB_EXPIRA_EN).
  const config = { fecha_exhibicion_fin: '2026-10-30T23:59:00-05:00' };
  const now = new Date('2026-10-05T15:00:00Z');
  assert.equal(dbExpiry(config, now, { DB_EXPIRA_EN: '2026-11-04' }).level, 'ok');
  assert.equal(dbExpiry(config, now, { DB_EXPIRA_EN: '2026-11-04' }).daysLeft, 30);
  assert.equal(dbExpiry(config, now, { DB_EXPIRA_EN: '2026-11-04' }).coversEvent, true);
  assert.equal(dbExpiry(config, now, {}).daysNeeded, 29, 'hoy → fin de exhibición + 3 días');
  assert.equal(dbExpiry(config, now, { DB_EXPIRA_EN: '2026-10-11' }).level, 'warn', 'menos de 7 días');
  assert.equal(dbExpiry(config, now, { DB_EXPIRA_EN: '2026-10-07' }).level, 'danger', '2 días o menos');
  assert.equal(dbExpiry(config, now, { DB_EXPIRA_EN: '2026-10-01' }).daysLeft < 0, true, 'vencida');
  assert.equal(dbExpiry(config, now, { DB_EXPIRA_EN: '2026-10-31' }).coversEvent, false, 'vence sin margen para exportar');
  assert.equal(dbExpiry(config, now, { DB_EXPIRA_EN: '2026-10-31' }).level, 'warn');
  assert.equal(dbExpiry(config, now, { DB_EXPIRA_EN: '31/10/2026' }).invalid, '31/10/2026');
  assert.equal(dbExpiry(config, now, { NODE_ENV: 'production' }).level, 'warn', 'sin configurar en producción avisa');
  // En el tablero: color según días restantes y tamaño con alerta al 70 %.
  const inDays = days => new Date(Date.now() + days * 86400000 - 5 * 3600000).toISOString().slice(0, 10);
  process.env.DB_EXPIRA_EN = inDays(20); process.env.DB_LIMITE_MB = '100000';
  let dash = await (await get('/admin', { headers: { cookie: admin } })).text();
  assert.match(dash, /class="ops-status ops-(ok|warn)" id="vencimiento-base"/); assert.match(dash, /Fecha de expiración de la base/);
  assert.match(dash, /class="ops-status ops-ok" id="tamano-base"/); assert.match(dash, /<th scope="row">investigaciones<\/th>/);
  process.env.DB_EXPIRA_EN = inDays(5); process.env.DB_LIMITE_MB = '1';
  dash = await (await get('/admin', { headers: { cookie: admin } })).text();
  assert.match(dash, /class="ops-status ops-warn" id="vencimiento-base"/, 'menos de 7 días cambia de color');
  assert.match(dash, /class="ops-status ops-danger" id="tamano-base"/); assert.match(dash, /Pasó del 70 %/);
  assert.match(dash, /Diagnóstico del proxy/);

  // URL de QR: https obligatorio y confirmación atada a la BASE_URL exacta.
  process.env.BASE_URL = 'http://postea.example.org';
  assert.equal(baseUrlProblem(), 'BASE_URL no usa https://');
  process.env.BASE_URL = 'https://postea-imago.onrender.com';
  assert.equal(baseUrlProblem(), null);
  const csrf = csrfOf(await (await get('/admin/configuracion', { headers: { cookie: admin } })).text());
  res = await get('/admin/configuracion/url-qr', { method: 'POST', headers: { cookie: admin }, body: new URLSearchParams({ _csrf: csrf, accion: 'confirmar', entiendo: 'on' }) });
  assert.equal(res.status, 302);
  const cfg = async () => Object.fromEntries((await pool.query('SELECT clave,valor FROM configuracion')).rows.map(r => [r.clave, r.valor]));
  assert.equal((await cfg()).url_qr_confirmada_para, 'https://postea-imago.onrender.com');
  assert.equal(qrUrlProblem(await cfg()), null, 'confirmada: se puede imprimir');
  process.env.BASE_URL = 'https://postea.ucompensar.edu.co';
  assert.equal(qrUrlProblem(await cfg()), 'BASE_URL cambió después de confirmarla');
  const page = await (await get('/admin/configuracion', { headers: { cookie: admin } })).text();
  assert.match(page, /La URL confirmada era <code>https:\/\/postea-imago\.onrender\.com<\/code>/);
  assert.match(await (await get(`/investigaciones/${research}/pieza`, { headers: { cookie: admin } })).text(), /BASE_URL cambió después de confirmarla/);
  assert.equal(qrUrlProblem({ url_qr_confirmada: true }), 'BASE_URL cambió después de confirmarla', 'confirmación sin URL guardada no cuenta');

  console.log('Operación OK: /health liveness y /health/db, gzip, mini ≤1080 px con ETag/304 e invalidación, respaldo JSON y ZIP por partes (CRC, propuesta en base64, imágenes como archivos), una exportación a la vez, vencimiento y tamaño de la base en el tablero, y URL de QR atada a la BASE_URL confirmada.');
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  try {
    for (const [key, value] of Object.entries(originalEnv)) value === undefined ? delete process.env[key] : process.env[key] = value;
    if (savedConfig) {
      const saved = new Set(savedConfig.map(r => r.clave));
      for (const r of savedConfig) await pool.query('UPDATE configuracion SET valor=$2 WHERE clave=$1', [r.clave, JSON.stringify(r.valor)]);
      for (const key of ['url_qr_confirmada_para']) if (!saved.has(key)) await pool.query('DELETE FROM configuracion WHERE clave=$1', [key]);
    }
    for (const id of [research, draft].filter(Boolean)) { await pool.query('DELETE FROM visitas WHERE investigacion_id=$1', [id]); await pool.query('DELETE FROM investigaciones WHERE id=$1', [id]); }
    if (author) await pool.query('DELETE FROM usuarios WHERE id=$1', [author]);
    if (program) await pool.query('DELETE FROM programas WHERE id=$1', [program]);
  } finally { server.close(); await pool.end(); }
});
