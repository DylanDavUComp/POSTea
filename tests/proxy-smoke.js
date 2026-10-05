// Proxy de Render: cookie Secure detrás de HTTPS, límites por IP real (no la del proxy) y HMAC de visitas por IP real.
// Corre en modo producción a propósito (es lo que cambia `trust proxy` y la cookie), contra la base de pruebas sin SSL.
require('dotenv').config({ quiet: true });
process.env.NODE_ENV = 'production';
process.env.DB_SSL = 'false';
delete process.env.TRUST_PROXY; // Valor por defecto en producción: 1.
process.env.CLIENT_IP_HEADER = 'cf-connecting-ip';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const app = require('../src/app');
const { pool } = require('../src/db');
const { clientIp, trustProxySetting } = require('../src/client-ip');
const { visitorHash } = require('../src/public');
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
const HTTPS = { 'x-forwarded-proto': 'https' };
const cookieOf = res => res.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
const csrfOf = html => html.match(/name="_csrf" value="([a-f0-9]+)"/)[1];
const suffix = crypto.randomBytes(5).toString('hex');

// Formulario con sesión (detrás del proxy HTTPS) para enviar POSTs válidos.
async function form(path) {
  const page = await fetch(base + path, { headers: HTTPS });
  return { cookie: cookieOf(page), csrf: csrfOf(await page.text()) };
}
const post = (path, { cookie, csrf }, headers, body) => fetch(base + path, { method: 'POST', redirect: 'manual',
  headers: { ...HTTPS, cookie, ...headers }, body: new URLSearchParams({ _csrf: csrf, ...body }) });

async function main() {
  assert.equal(trustProxySetting({ NODE_ENV: 'production' }), 1);
  assert.equal(trustProxySetting({ NODE_ENV: 'development' }), false);
  assert.equal(trustProxySetting({ TRUST_PROXY: '3' }), 3);
  assert.equal(app.get('trust proxy'), 1);

  // (a) Cookie Secure: con X-Forwarded-Proto: https el balanceador indica HTTPS y la sesión se envía con Secure.
  let res = await fetch(`${base}/ingresar`, { headers: HTTPS });
  assert.match(res.headers.get('set-cookie') || '', /postea\.sid=.*;.*Secure/i, 'cookie Secure detrás del proxy HTTPS');
  // Sin el ajuste (Express no confía en el proxy) req.secure es false y express-session no envía la cookie: nadie podría ingresar.
  app.set('trust proxy', false);
  res = await fetch(`${base}/ingresar`, { headers: HTTPS });
  assert.equal(res.headers.get('set-cookie'), null, 'sin trust proxy no hay cookie de sesión');
  app.set('trust proxy', 1);

  // clientIp: cabecera de Cloudflare si es una IP válida; si falta o es basura, req.ip.
  const fake = headers => ({ ip: '10.0.0.9', get: name => headers[name.toLowerCase()] });
  assert.equal(clientIp(fake({ 'cf-connecting-ip': '181.49.10.20' })), '181.49.10.20');
  assert.equal(clientIp(fake({ 'cf-connecting-ip': '2800:e2:1::5' })), '2800:e2:1::5');
  assert.equal(clientIp(fake({ 'cf-connecting-ip': 'no-es-ip' })), '10.0.0.9');
  assert.equal(clientIp(fake({})), '10.0.0.9');

  // (b) Ingreso fallido: 10 por IP + correo. La IP es la del visitante (cf-connecting-ip), no la del proxy (igual para todos).
  const email = `limite-${suffix}@example.com`;
  const attacker = await form('/ingresar');
  for (let i = 0; i < 10; i++) {
    // X-Forwarded-For cambia en cada intento (falsificable): no debe servir para saltarse el límite.
    res = await post('/ingresar', attacker, { 'cf-connecting-ip': '181.49.10.20', 'x-forwarded-for': `1.2.3.${i}` }, { email, password: 'incorrecta-123' });
    assert.equal(res.status, 400, `intento fallido ${i + 1}`);
  }
  res = await post('/ingresar', attacker, { 'cf-connecting-ip': '181.49.10.20', 'x-forwarded-for': '9.9.9.9' }, { email, password: 'incorrecta-123' });
  assert.equal(res.status, 429, 'el intento 11 desde la misma IP real se bloquea');
  const neighbor = await form('/ingresar');
  res = await post('/ingresar', neighbor, { 'cf-connecting-ip': '181.49.10.21' }, { email, password: 'incorrecta-123' });
  assert.equal(res.status, 400, 'otra persona (otra IP real) no queda bloqueada');

  // Registro: 60 por IP cada 15 min. Formularios inválidos cuentan igual (sin crear cuentas).
  const signup = await form('/registro');
  for (let i = 0; i < 60; i++) {
    res = await post('/registro', signup, { 'cf-connecting-ip': '181.49.30.1' }, { nombre: '' });
    assert.notEqual(res.status, 429, `registro ${i + 1} permitido`);
  }
  res = await post('/registro', signup, { 'cf-connecting-ip': '181.49.30.1' }, { nombre: '' });
  assert.equal(res.status, 429, 'el registro 61 desde la misma IP real se bloquea');
  res = await post('/registro', signup, { 'cf-connecting-ip': '181.49.30.2' }, { nombre: '' });
  assert.notEqual(res.status, 429, 'otra IP real sigue pudiendo registrarse');

  // (c) HMAC de visitas: misma IP real + mismo navegador = misma huella aunque cambie X-Forwarded-For; otra IP = otra huella.
  const visit = (ip, xff) => ({ ip: '10.0.0.9', get: name => ({ 'cf-connecting-ip': ip, 'x-forwarded-for': xff, 'user-agent': 'Mozilla/5.0 prueba' })[name.toLowerCase()] });
  assert.equal(visitorHash(visit('181.49.10.20', '1.1.1.1')), visitorHash(visit('181.49.10.20', '2.2.2.2')));
  assert.notEqual(visitorHash(visit('181.49.10.20', '1.1.1.1')), visitorHash(visit('181.49.10.21', '1.1.1.1')));

  console.log('Proxy OK: trust proxy 1 en producción, cookie Secure tras HTTPS (y sin cookie si no se confía en el proxy), límites de ingreso y registro por IP real (cf-connecting-ip, X-Forwarded-For falsificado no los evade) y HMAC de visitas por IP real.');
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  server.close();
  await pool.end();
});
