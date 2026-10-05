// Resiliencia ante la base de Render (mantenimientos y reinicios sin aviso), con un proxy TCP que se puede cortar:
// - las migraciones reintentan con espera progresiva si la base aún no acepta conexiones, y se rinden tras N intentos;
// - con la base caída en caliente, las páginas responden 503 amable, /health sigue en 200 (Render no reinicia),
//   /health/db da 503, y todo se recupera solo al volver la base, sin reiniciar el proceso.
require('dotenv').config({ quiet: true });
const assert = require('node:assert/strict');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
if (process.env.NODE_ENV === 'production') throw new Error('Prueba reservada a desarrollo.');
const target = new URL(process.env.DATABASE_URL);

// Proxy hacia la base real: open() empieza a aceptar, cut() cierra todo (como un mantenimiento).
function dbProxy(port) {
  const sockets = new Set();
  let server = null;
  return {
    open: () => new Promise(resolve => {
      server = net.createServer(client => {
        const upstream = net.connect(Number(target.port || 5432), target.hostname);
        for (const s of [client, upstream]) { sockets.add(s); s.on('close', () => sockets.delete(s)); s.on('error', () => {}); }
        client.pipe(upstream).pipe(client);
      }).listen(port, '127.0.0.1', resolve);
    }),
    cut: () => new Promise(resolve => { for (const s of sockets) s.destroy(); server ? server.close(() => resolve()) : resolve(); server = null; })
  };
}
const freePort = () => new Promise(resolve => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const viaProxy = port => { const url = new URL(process.env.DATABASE_URL); url.hostname = '127.0.0.1'; url.port = String(port); return url.toString(); };

function migrate(url, env) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['scripts/migrate.js'], { cwd: path.join(__dirname, '..'),
      env: { ...process.env, DATABASE_URL: url, DB_SSL: 'false', ...env } });
    let output = '';
    child.stdout.on('data', d => { output += d; }); child.stderr.on('data', d => { output += d; });
    child.on('close', code => resolve({ code, output }));
  });
}

async function main() {
  // 1. La base tarda en aparecer: el proxy abre después de ~0,7 s y la migración termina bien.
  let port = await freePort();
  const late = dbProxy(port);
  const timer = setTimeout(() => late.open(), 700);
  const started = Date.now();
  let result = await migrate(viaProxy(port), { DB_CONNECT_RETRIES: '8', DB_RETRY_BASE_MS: '100' });
  clearTimeout(timer); await late.cut();
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /La base no responde \(ECONNREFUSED\)\. Intento 1\/8; reintento en 0\.1 s\./);
  assert.match(result.output, /Intento 2\/8; reintento en 0\.2 s\./, 'espera progresiva');
  assert.match(result.output, /Migraciones al día\./);
  assert.ok(Date.now() - started >= 700, 'esperó a la base');

  // 2. La base nunca aparece: se rinde tras los intentos configurados, con código de error.
  port = await freePort();
  result = await migrate(viaProxy(port), { DB_CONNECT_RETRIES: '3', DB_RETRY_BASE_MS: '50' });
  assert.equal(result.code, 1);
  assert.match(result.output, /Intento 2\/3/); assert.doesNotMatch(result.output, /Intento 3\/3/);
  assert.match(result.output, /Error al migrar \(127\.0\.0\.1:\d+\/[^)]+\): .*ECONNREFUSED|Error al migrar/);

  // 3. Caída en caliente: la app arranca a través del proxy (el pool se crea al requerir src/db, por eso va después).
  port = await freePort();
  const live = dbProxy(port);
  await live.open();
  process.env.DATABASE_URL = viaProxy(port);
  const app = require('../src/app');
  const { pool, isDbUnavailable } = require('../src/db');
  // Un error de SQL no se reintenta ni se trata como caída (no es un problema de conexión).
  assert.equal(isDbUnavailable({ code: '42P01', message: 'relation "x" does not exist' }), false);
  assert.equal(isDbUnavailable({ code: '57P01' }), true);
  assert.equal(isDbUnavailable(new Error('Connection terminated unexpectedly')), true);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${base}/`)).status, 200);
    assert.equal((await fetch(`${base}/health/db`)).status, 200);
    await live.cut();
    let res = await fetch(`${base}/`);
    assert.equal(res.status, 503, 'página con la base caída');
    assert.equal(res.headers.get('retry-after'), '30');
    assert.match(await res.text(), /Volvemos en un momento/);
    res = await fetch(`${base}/muro`);
    assert.equal(res.status, 503);
    assert.equal((await fetch(`${base}/health`)).status, 200, 'liveness sigue en 200: Render no reinicia por un mantenimiento');
    assert.equal((await fetch(`${base}/health/db`)).status, 503, 'readiness refleja la base caída');
    await live.open();
    // El pool descarta las conexiones rotas y abre nuevas: sin reiniciar el proceso.
    let status = 0;
    for (let i = 0; i < 10 && status !== 200; i++) { status = (await fetch(`${base}/`)).status; if (status !== 200) await new Promise(r => setTimeout(r, 200)); }
    assert.equal(status, 200, 'se recupera sola al volver la base');
    assert.equal((await fetch(`${base}/health/db`)).status, 200);
  } finally {
    server.close(); await live.cut(); await pool.end().catch(() => {});
  }

  console.log('Resiliencia OK: migraciones con reintento progresivo (espera a la base y se rinde tras N intentos; SQL no se reintenta), 503 amable con Retry-After con la base caída, /health en 200 durante el corte, /health/db en 503 y recuperación sin reiniciar.');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
