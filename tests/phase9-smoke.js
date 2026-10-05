require('dotenv').config({ quiet: true });
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
if (process.env.NODE_ENV === 'production') throw new Error('Prueba reservada a desarrollo.');
const app = require('../src/app');
const { pool } = require('../src/db');
const { ensureAdmin } = require('../src/seed-admin');
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const walk = dir => fs.readdirSync(path.join(root, dir), { withFileTypes: true })
  .flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
const get = (p, options = {}) => fetch(base + p, { redirect: 'manual', ...options });
const tempEmail = `admin-f9-${crypto.randomBytes(5).toString('hex')}@example.com`;

// Recorre el enrutador de Express 5 y devuelve todas las rutas POST registradas.
function postRoutes(stack = app.router.stack, found = []) {
  for (const layer of stack) {
    if (layer.route?.methods?.post) found.push(layer.route.path);
    else if (layer.handle?.stack) postRoutes(layer.handle.stack, found);
  }
  return found;
}

async function main() {
  // Blueprint: lo que exige §10 de la especificación, con runtime Docker (ver DECISIONES.md).
  const blueprint = read('render.yaml');
  for (const line of ['name: postea-imago', 'plan: free', 'runtime: docker', 'dockerfilePath: ./Dockerfile',
    'healthCheckPath: /health', 'name: postea-db', 'property: connectionString', 'key: SESSION_SECRET', 'generateValue: true']) {
    assert.ok(blueprint.includes(line), `render.yaml incluye «${line}»`);
  }
  // Producción segura: NODE_ENV, IP real tras Cloudflare y secretos solo con sync: false (nunca con valor en el archivo).
  assert.match(blueprint, /- key: NODE_ENV\s+value: production/);
  assert.match(blueprint, /- key: CLIENT_IP_HEADER\s+value: cf-connecting-ip/);
  for (const secret of ['BASE_URL', 'ADMIN_EMAIL', 'ADMIN_PASSWORD', 'DB_EXPIRA_EN']) {
    assert.match(blueprint, new RegExp(`- key: ${secret}\\s+sync: false`), `${secret} se pide en Render (sync: false)`);
  }
  assert.equal((blueprint.match(/plan: free/g) || []).length, 2, 'web y base en plan free');
  // El contenedor migra y luego arranca; .env nunca entra en la imagen.
  assert.match(read('Dockerfile'), /^CMD \["sh", "-c", "node scripts\/migrate\.js && exec node src\/server\.js"\]$/m);
  assert.ok(read('.dockerignore').split(/\r?\n/).includes('.env'), '.env excluido de la imagen');
  const regions = [...blueprint.matchAll(/^\s+region:\s*(\S+)/gm)].map(m => m[1]);
  assert.equal(regions.length, 2); assert.equal(regions[0], regions[1], 'web y base en la misma región');
  assert.ok(!/^\s*branch:/m.test(blueprint), 'usa la rama por defecto del repositorio');

  // Toda variable de entorno usada por el código está documentada en .env.example.
  const example = read('.env.example');
  const used = new Set(walk('src').concat(walk('scripts')).filter(f => f.endsWith('.js'))
    .flatMap(f => [...read(f).matchAll(/process\.env\.([A-Z_]+)/g)].map(m => m[1])));
  for (const name of used) assert.match(example, new RegExp(`^${name}=`, 'm'), `.env.example documenta ${name}`);
  assert.ok(read('.gitignore').split(/\r?\n/).includes('.env'), '.env ignorado por git');

  // CSP: sin scripts ni estilos en línea en las vistas; sin escrituras a disco en el código.
  for (const file of walk('src/views')) {
    const html = read(file);
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/, `${file}: sin <script> en línea`);
    assert.doesNotMatch(html, /\sstyle="/, `${file}: sin style en línea`);
    assert.doesNotMatch(html, /\son[a-z]+="/, `${file}: sin manejadores on*`);
  }
  for (const file of walk('src').filter(f => f.endsWith('.js'))) {
    assert.doesNotMatch(read(file), /\bfs\.(writeFile|appendFile|createWriteStream|mkdir)/, `${file}: no escribe en disco`);
  }

  // Encabezados de seguridad.
  const home = await get('/');
  assert.equal(home.headers.get('x-powered-by'), null);
  assert.match(home.headers.get('content-security-policy'), /default-src 'self'/);
  assert.match(home.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(home.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(home.headers.get('referrer-policy'), 'no-referrer');

  // CSRF: con sesión de admin activa, cada ruta POST rechaza la petición sin token.
  const page = await get('/ingresar');
  let cookie = page.headers.get('set-cookie').split(';')[0];
  const token = (await page.text()).match(/name="_csrf" value="([a-f0-9]+)"/)[1];
  const login = await get('/ingresar', { method: 'POST', headers: { cookie },
    body: new URLSearchParams({ _csrf: token, email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }) });
  assert.equal(login.status, 302); cookie = login.headers.get('set-cookie').split(';')[0];
  const routes = [...new Set(postRoutes())];
  assert.ok(routes.length >= 25, `se encontraron ${routes.length} rutas POST`);
  for (const route of routes) {
    const concrete = route.replace(/:slug/g, 'x-slug').replace(/:token/g, 'A'.repeat(43)).replace(/:[a-z]+/g, '1');
    const res = await get(concrete, { method: 'POST', headers: { cookie }, body: new URLSearchParams({ campo: 'x' }) });
    await res.text();
    assert.equal(res.status, 403, `POST ${concrete} sin token CSRF → 403 (fue ${res.status})`);
  }
  // Y sigue con sesión: los rechazos no la cerraron.
  assert.equal((await get('/mi-cuenta', { headers: { cookie } })).status, 200);

  // Admin inicial idempotente.
  const saved = { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD };
  process.env.ADMIN_EMAIL = tempEmail; process.env.ADMIN_PASSWORD = 'clave-temporal-f9-123';
  assert.deepEqual(await ensureAdmin(), { created: true });
  assert.deepEqual(await ensureAdmin(), { created: false });
  const [admins] = (await pool.query('SELECT count(*)::int AS n FROM usuarios WHERE email=$1', [tempEmail])).rows;
  assert.equal(admins.n, 1);
  process.env.ADMIN_PASSWORD = 'corta';
  assert.equal((await ensureAdmin()).created, false);
  await assert.rejects(ensureAdmin({ required: true }), /mínimo 12 caracteres/);
  Object.assign(process.env, { ADMIN_EMAIL: saved.email, ADMIN_PASSWORD: saved.password });

  // El ingreso tarda lo mismo con un correo inexistente (no delata qué cuentas existen).
  const attempt = async email => {
    const p = await get('/ingresar'); const c = p.headers.get('set-cookie').split(';')[0];
    const t = (await p.text()).match(/name="_csrf" value="([a-f0-9]+)"/)[1];
    const start = process.hrtime.bigint();
    const r = await get('/ingresar', { method: 'POST', headers: { cookie: c }, body: new URLSearchParams({ _csrf: t, email, password: 'incorrecta-123' }) });
    await r.text(); assert.equal(r.status, 400);
    return Number(process.hrtime.bigint() - start) / 1e6;
  };
  const known = [], unknown = [];
  for (let i = 0; i < 3; i++) { known.push(await attempt(tempEmail)); unknown.push(await attempt(`nadie-${i}-${crypto.randomBytes(3).toString('hex')}@example.com`)); }
  const median = list => list.sort((a, b) => a - b)[1];
  assert.ok(median(unknown) > median(known) * 0.5, `tiempos parecidos (existe ${median(known).toFixed(0)} ms, no existe ${median(unknown).toFixed(0)} ms)`);
  console.log(`Fase 9 OK: render.yaml, .env.example completo, sin scripts/estilos en línea ni escritura a disco, encabezados, CSRF en ${routes.length} rutas POST, admin idempotente y tiempo de ingreso uniforme (${median(known).toFixed(0)}/${median(unknown).toFixed(0)} ms).`);
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  try {
    await pool.query('DELETE FROM usuarios WHERE email=$1', [tempEmail]);
  } finally { await new Promise(resolve => server.close(resolve)); await pool.end(); }
});
