require('dotenv').config({ quiet: true });
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const bcrypt = require('bcrypt');
if (process.env.NODE_ENV === 'production') throw new Error('Prueba reservada a desarrollo.');
const app = require('../src/app');
const { pool } = require('../src/db');
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
const suffix = crypto.randomBytes(6).toString('hex');
const get = (path, options = {}) => fetch(base + path, { redirect: 'manual', ...options });
const csrfOf = html => html.match(/name="_csrf" value="([a-f0-9]+)"/)[1];
const navLinks = html => [...html.match(/<nav class="header-nav"[\s\S]*?<\/nav>/)[0].matchAll(/href="([^"]+)"/g)].map(m => m[1]);
let visitor;

async function login(email, password) {
  const page = await get('/ingresar');
  const cookie = page.headers.get('set-cookie').split(';')[0];
  const res = await get('/ingresar', { method: 'POST', headers: { cookie },
    body: new URLSearchParams({ _csrf: csrfOf(await page.text()), email, password, next: '/mi-cuenta' }) });
  assert.equal(res.status, 302, `ingreso de ${email}`);
  return res.headers.get('set-cookie').split(';')[0];
}

async function checkNav(cookie, expected) {
  const home = await get('/', { headers: cookie ? { cookie } : {} });
  assert.equal(home.status, 200);
  const links = navLinks(await home.text());
  for (const link of expected) assert.ok(links.includes(link), `el encabezado incluye ${link}`);
  for (const link of links) {
    const res = await get(link, { headers: cookie ? { cookie } : {} });
    const html = await res.text();
    assert.equal(res.status, 200, `${link} responde 200`);
    assert.doesNotMatch(html, /Ocurrió un problema/, `${link} no falla`);
  }
}

async function main() {
  await checkNav(null, ['/muro', '/ingresar', '/registro']);
  const admin = await login(process.env.ADMIN_EMAIL, process.env.ADMIN_PASSWORD);
  await checkNav(admin, ['/muro', '/panel', '/coordinacion', '/admin', '/mi-cuenta']);

  const password = crypto.randomBytes(16).toString('hex');
  visitor = (await pool.query(`INSERT INTO usuarios(nombre,email,password_hash,rol,estado,tipo_persona,acepta_datos_at,acepta_datos_version)
    VALUES('DEMO navegación',$1,$2,'visitante','activo','externo',now(),'prueba') RETURNING id,email`,
  [`nav-${suffix}@example.com`, await bcrypt.hash(password, 10)])).rows[0];
  const cookie = await login(visitor.email, password);
  await checkNav(cookie, ['/muro', '/mi-cuenta']);

  // Salir desde el encabezado de cualquier página.
  const wall = await (await get('/muro', { headers: { cookie } })).text();
  assert.match(wall, /action="\/salir"/, 'botón Salir en el encabezado');
  const out = await get('/salir', { method: 'POST', headers: { cookie }, body: new URLSearchParams({ _csrf: csrfOf(wall) }) });
  assert.equal(out.status, 302); assert.equal(out.headers.get('location'), '/?salida=1');
  const farewell = await get('/?salida=1');
  assert.equal(farewell.status, 200); assert.match(await farewell.text(), /Cerraste sesión/);
  assert.equal((await get('/mi-cuenta', { headers: { cookie } })).status, 302, 'la sesión quedó cerrada');

  // Cerrar sesión otra vez (pestaña vieja o sesión vencida) no muestra error.
  const again = await get('/salir', { method: 'POST', headers: { cookie }, body: new URLSearchParams({ _csrf: csrfOf(wall) }) });
  assert.equal(again.status, 302); assert.equal(again.headers.get('location'), '/?salida=1');
  assert.equal((await get('/salir')).headers.get('location'), '/');
  assert.equal((await get('/salir', { headers: { cookie: admin } })).headers.get('location'), '/mi-cuenta');

  // Con sesión activa, un POST sin token sigue rechazado.
  assert.equal((await get('/salir', { method: 'POST', headers: { cookie: admin }, body: new URLSearchParams({}) })).status, 403);
  console.log('Navegación OK: enlaces del encabezado por rol, salida desde cualquier página, salida repetida sin error y CSRF.');
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  try {
    if (visitor) {
      await pool.query("DELETE FROM sesiones WHERE sess->>'userId'=$1", [String(visitor.id)]);
      await pool.query('DELETE FROM usuarios WHERE id=$1', [visitor.id]);
    }
  } finally { await new Promise(resolve => server.close(resolve)); await pool.end(); }
});
