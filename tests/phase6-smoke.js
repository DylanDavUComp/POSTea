require('dotenv').config({ quiet: true });
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const bcrypt = require('bcrypt');
const sharp = require('sharp');
if (process.env.NODE_ENV === 'production') throw new Error('Prueba reservada a desarrollo.');
const app = require('../src/app');
const { pool } = require('../src/db');
const { invest, blockedWord, publicName } = require('../src/interaction');
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
const suffix = crypto.randomBytes(6).toString('hex');
const password = crypto.randomBytes(16).toString('hex');
const users = {}, items = [];
let program, savedConfig = [];

const get = (path, options = {}) => fetch(base + path, { redirect: 'manual', ...options });
const csrfOf = html => html.match(/name="_csrf" value="([a-f0-9]+)"/)[1];
const operationOf = html => html.match(/name="operacion" value="([0-9a-f-]{36})"/)[1];
const setConfig = async values => { for (const [k, v] of Object.entries(values)) {
  await pool.query('INSERT INTO configuracion(clave,valor) VALUES($1,$2::jsonb) ON CONFLICT (clave) DO UPDATE SET valor=EXCLUDED.valor', [k, JSON.stringify(v)]);
} };
const day = 24 * 60 * 60 * 1000;
const iso = ms => new Date(Date.now() + ms).toISOString();
const openExhibition = () => setConfig({ fecha_exhibicion_inicio: iso(-day), fecha_exhibicion_fin: iso(2 * day),
  inversion_activa: true, comentarios_activos: true, moderacion_previa: false, saldo_inicial_monedas: 100, nombre_moneda: 'Imagos' });
const spent = async id => (await pool.query('SELECT coalesce(sum(monedas),0)::int AS n, count(*)::int AS c FROM inversiones WHERE usuario_id=$1', [id])).rows[0];

async function login(user, secret = password) {
  const page = await get('/ingresar');
  let cookie = page.headers.get('set-cookie').split(';')[0];
  const res = await get('/ingresar', { method: 'POST', headers: { cookie },
    body: new URLSearchParams({ _csrf: csrfOf(await page.text()), email: user.email, password: secret, next: '/mi-cuenta' }) });
  assert.equal(res.status, 302);
  cookie = res.headers.get('set-cookie').split(';')[0];
  return cookie;
}
async function fiche(cookie, slug = items[0].slug, query = '') {
  const res = await get(`/f/${slug}${query}`, { headers: cookie ? { cookie } : {} });
  assert.equal(res.status, 200);
  return res.text();
}
async function post(cookie, path, fields) {
  const res = await get(path, { method: 'POST', headers: { cookie }, body: new URLSearchParams(fields) });
  await res.text();
  return res;
}
// Envía el formulario de la ficha como lo haría el navegador (token y operación nuevos de la página).
async function act(cookie, action, fields, slug = items[0].slug) {
  const html = await fiche(cookie, slug);
  const res = await post(cookie, `/f/${slug}/${action}`, { _csrf: csrfOf(html), operacion: operationOf(html), ...fields });
  assert.equal(res.status, 302);
  return fiche(cookie, slug);
}

async function main() {
  savedConfig = (await pool.query('SELECT clave,valor FROM configuracion')).rows;
  const faculty = (await pool.query('SELECT id FROM facultades ORDER BY id LIMIT 1')).rows[0];
  const territory = (await pool.query('SELECT id FROM territorios ORDER BY id LIMIT 1')).rows[0];
  program = (await pool.query('INSERT INTO programas(nombre,facultad_id) VALUES($1,$2) RETURNING id', [`DEMO fase6 ${suffix}`, faculty.id])).rows[0].id;
  const hash = await bcrypt.hash(password, 10);
  for (const [key, rol, nombre] of [['autor', 'autor', 'Autora Demo'], ['v1', 'visitante', 'Valentina Ruiz Demo'], ['v2', 'visitante', 'Visitante Dos'], ['v3', 'visitante', 'Visitante Tres']]) {
    users[key] = (await pool.query(`INSERT INTO usuarios(nombre,email,password_hash,rol,estado,tipo_persona,programa_id,acepta_datos_at,acepta_datos_version)
      VALUES($1,$2,$3,$4,'activo','externo',$5,now(),'prueba') RETURNING id,email`, [nombre, `f6-${key}-${suffix}@example.com`, hash, rol, program])).rows[0];
  }
  const image = await sharp({ create: { width: 20, height: 20, channels: 3, background: '#5b2a9e' } }).webp().toBuffer();
  for (let n = 0; n < 2; n++) {
    items.push((await pool.query(`INSERT INTO investigaciones(slug,programa_id,territorio_id,autor_id,titulo,pregunta_gancho,descripcion,objetivo,metodologia,resultados,
      estado_investigacion,tipo,imagen,imagen_mime,estado_flujo,publicada_at) VALUES($1,$2,$3,$4,$5,'Pregunta DEMO','D','O','M','R','terminada','investigacion',$6,'image/webp','publicada',now())
      RETURNING id,slug`, [`fase6-${suffix}-${n}`, program, territory.id, users.autor.id, `DEMO fase6 ${n}`, image])).rows[0]);
  }

  // Utilidades puras.
  assert.equal(publicName('María Fernanda Rojas'), 'María F.');
  assert.equal(blockedWord('Qué GONORREA de idea', ['gonorrea']), 'gonorrea');
  assert.equal(blockedWord('Me parecen estúpidos', ['estupido']), 'estupido');
  assert.equal(blockedWord('Un análisis estupendo', ['estupido']), null);

  // Antes de la exhibición: aviso amable, sin formulario.
  await setConfig({ fecha_exhibicion_inicio: '2099-10-27', fecha_exhibicion_fin: '2099-10-30T23:59:00-05:00', inversion_activa: true, comentarios_activos: true });
  let html = await fiche(null);
  assert.match(html, /La inversión se activa el 27 de octubre/); assert.doesNotMatch(html, /\/participar/);

  await openExhibition();
  // Sin cuenta: el formulario lleva al registro con la intención y vuelve a la ficha para confirmar.
  html = await fiche(null);
  assert.match(html, /action="\/f\/[^"]+\/participar"/); assert.match(html, /Crear cuenta e invertir/);
  let res = await get(`/f/${items[0].slug}/participar?accion=invertir&monedas=10`);
  assert.equal(res.headers.get('location'), `/registro?next=${encodeURIComponent(`/f/${items[0].slug}?confirmar=10#invierte`)}`);
  res = await get(`/f/${items[0].slug}/participar?accion=comentar&tipo=conexion`);
  assert.equal(res.headers.get('location'), `/registro?next=${encodeURIComponent(`/f/${items[0].slug}?tipo=conexion#comenta`)}`);
  // POST sin sesión (sesión vencida): a ingresar, sin error.
  res = await post('', `/f/${items[0].slug}/invertir`, { monedas: '5' });
  assert.equal(res.status, 302); assert.match(res.headers.get('location'), /^\/ingresar\?next=/);

  const v1 = await login(users.v1), v2 = await login(users.v2), v3 = await login(users.v3), author = await login(users.autor);
  html = await fiche(v1, items[0].slug, '?confirmar=20');
  assert.match(html, /Tienes <strong>100 Imagos/); assert.match(html, /Confirma tu inversión de <strong>20 Imagos/);
  assert.match(html, /value="20" checked/);

  // Criterio de aceptación: 10 inversiones simultáneas de 30 con saldo 100 → exactamente 3 pasan, saldo 10, nunca negativo.
  const pages = await Promise.all(Array.from({ length: 10 }, () => fiche(v1)));
  const results = await Promise.all(pages.map(page => post(v1, `/f/${items[0].slug}/invertir`,
    { _csrf: csrfOf(page), operacion: operationOf(page), monedas: '30' })));
  assert.ok(results.every(r => r.status === 302));
  assert.deepEqual(await spent(users.v1.id), { n: 90, c: 3 }, 'solo caben tres inversiones de 30');
  // También directo contra la función, con 25 intentos simultáneos de 7 sobre el saldo restante de 10.
  const direct = await Promise.allSettled(Array.from({ length: 25 }, () => invest({ userId: users.v1.id, slug: items[1].slug, coins: 7, operation: crypto.randomUUID() })));
  assert.equal(direct.filter(r => r.status === 'fulfilled').length, 1);
  assert.deepEqual(await spent(users.v1.id), { n: 97, c: 4 }, 'el saldo nunca queda negativo');
  html = await fiche(v1);
  assert.match(html, /Tienes <strong>3 Imagos/);
  assert.match(html, /<strong>90<\/strong> Imagos invertidos por 1 persona/);
  html = await act(v1, 'invertir', { monedas: '10' });
  assert.match(html, /Solo te quedan 3 Imagos/);
  html = await act(v1, 'invertir', { monedas: '', monedas_otra: '3' });
  assert.match(html, /Invertiste 3 Imagos en esta idea! Te quedan 0/);
  assert.match(html, /Ya invertiste todas tus Imagos/);

  // Doble clic: el mismo formulario enviado dos veces a la vez solo cuenta una vez.
  const page2 = await fiche(v2);
  const twice = { _csrf: csrfOf(page2), operacion: operationOf(page2), monedas: '5' };
  await Promise.all([post(v2, `/f/${items[0].slug}/invertir`, twice), post(v2, `/f/${items[0].slug}/invertir`, twice)]);
  assert.deepEqual(await spent(users.v2.id), { n: 5, c: 1 }, 'doble clic no duplica');
  // Cantidades inválidas.
  for (const monedas of ['0', '-5', 'abc', '1.5']) assert.match(await act(v2, 'invertir', { monedas }), /Elige cuántas monedas/);
  // El autor no invierte en su propia investigación.
  html = await fiche(author);
  assert.match(html, /Esta es tu investigación/);
  await post(author, `/f/${items[0].slug}/invertir`, { _csrf: csrfOf(html), operacion: crypto.randomUUID(), monedas: '5' });
  assert.equal((await spent(users.autor.id)).c, 0);
  // Flag desactivado y exhibición terminada.
  await setConfig({ inversion_activa: false });
  assert.match(await act(v2, 'invertir', { monedas: '5' }), /La inversión no está disponible en este momento/);
  assert.equal((await spent(users.v2.id)).c, 1, 'con el flag apagado no se invierte');
  await setConfig({ inversion_activa: true, fecha_exhibicion_inicio: iso(-3 * day), fecha_exhibicion_fin: iso(-day) });
  html = await fiche(v2);
  assert.match(html, /La inversión cerró el/);
  await post(v2, `/f/${items[0].slug}/invertir`, { _csrf: csrfOf(html), operacion: crypto.randomUUID(), monedas: '5' });
  assert.equal((await spent(users.v2.id)).c, 1, 'fuera de fechas no se invierte');
  await openExhibition();

  // Comentarios.
  html = await act(v1, 'comentar', { tipo: 'pregunta', texto: '¿Cómo se replicaría <b>esto</b> en Soacha?' });
  assert.match(html, /Tu comentario ya está publicado/);
  assert.match(html, /¿Cómo se replicaría &lt;b&gt;esto&lt;\/b&gt; en Soacha\?/);
  assert.match(html, /Valentina R\./); assert.doesNotMatch(html, /Valentina Ruiz Demo/);
  html = await act(v1, 'comentar', { tipo: 'conexion', texto: 'Esto es una gonorrea' });
  assert.match(html, /palabras que no están permitidas/);
  assert.match(html, /Esto es una gonorrea<\/textarea>/, 'el borrador se conserva');
  assert.match(await act(v1, 'comentar', { tipo: 'chiste', texto: 'Hola a todos' }), /Elige si es una pregunta/);
  assert.match(await act(v1, 'comentar', { tipo: 'pregunta', texto: 'x'.repeat(501) }), /hasta 500 caracteres/);
  // Doble clic en comentario.
  const cpage = await fiche(v2);
  const cfields = { _csrf: csrfOf(cpage), operacion: operationOf(cpage), tipo: 'aplicacion', texto: 'Se podría aplicar en colegios distritales.' };
  await Promise.all([post(v2, `/f/${items[0].slug}/comentar`, cfields), post(v2, `/f/${items[0].slug}/comentar`, cfields)]);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM comentarios WHERE usuario_id=$1', [users.v2.id])).rows[0].n, 1);
  // Límite de 10 por hora.
  await pool.query(`INSERT INTO comentarios(usuario_id,investigacion_id,tipo,texto) SELECT $1,$2,'pregunta','Relleno DEMO' FROM generate_series(1,9)`, [users.v2.id, items[1].id]);
  assert.match(await act(v2, 'comentar', { tipo: 'pregunta', texto: 'El número once' }), /hasta 10 comentarios por hora/);

  // Moderación previa: solo lo ve quien lo escribió.
  await setConfig({ moderacion_previa: true });
  html = await act(v3, 'comentar', { tipo: 'conexion', texto: 'Conecta con movilidad sostenible.' });
  assert.match(html, /se publicará cuando IMAGO lo revise/); assert.match(html, /Solo tú lo ves/);
  assert.doesNotMatch(await fiche(null), /Conecta con movilidad sostenible/);
  await setConfig({ moderacion_previa: false });

  // Reportes: el comentario sale de la vista pública hasta que IMAGO decide.
  const target = (await pool.query('SELECT id FROM comentarios WHERE usuario_id=$1 AND estado=$2', [users.v1.id, 'visible'])).rows[0].id;
  html = await fiche(v1);
  assert.doesNotMatch(html, new RegExp(`/comentarios/${target}/reportar`), 'no se reporta el propio');
  html = await fiche(v2);
  res = await post(v2, `/comentarios/${target}/reportar`, { _csrf: csrfOf(html) });
  assert.equal(res.status, 302);
  assert.equal((await pool.query('SELECT estado FROM comentarios WHERE id=$1', [target])).rows[0].estado, 'reportado');
  assert.doesNotMatch(await fiche(null), /replicaría/);
  assert.match(await fiche(v1), /IMAGO está revisando este comentario/);
  // Admin: panel, aprobar (un nuevo reporte ya no lo oculta) y ocultar.
  const adminCookie = await login({ email: process.env.ADMIN_EMAIL }, process.env.ADMIN_PASSWORD);
  assert.equal((await get('/admin/moderacion', { headers: { cookie: v1 } })).status, 403);
  const modPage = await (await get('/admin/moderacion', { headers: { cookie: adminCookie } })).text();
  assert.match(modPage, new RegExp(`comentario-${target}`)); assert.match(modPage, /1 reporte/);
  await post(adminCookie, `/admin/moderacion/${target}/mostrar`, { _csrf: csrfOf(modPage) });
  html = await fiche(v3);
  await post(v3, `/comentarios/${target}/reportar`, { _csrf: csrfOf(html) });
  assert.equal((await pool.query('SELECT estado FROM comentarios WHERE id=$1', [target])).rows[0].estado, 'visible', 'aprobado por IMAGO no se vuelve a ocultar');
  assert.match(await fiche(null), /replicaría/);
  await post(adminCookie, `/admin/moderacion/${target}/ocultar`, { _csrf: csrfOf(modPage) });
  assert.doesNotMatch(await fiche(null), /replicaría/);
  // Ajustes de moderación.
  await post(adminCookie, '/admin/moderacion-ajustes', { _csrf: csrfOf(modPage), palabras: 'Tontería\nbobada, tontería', moderacion_previa: 'on' });
  const cfg = Object.fromEntries((await pool.query(`SELECT clave,valor FROM configuracion WHERE clave IN ('palabras_bloqueadas','moderacion_previa')`)).rows.map(r => [r.clave, r.valor]));
  assert.deepEqual(cfg, { palabras_bloqueadas: ['tontería', 'bobada'], moderacion_previa: true });
  assert.equal((await post(v1, '/admin/moderacion-ajustes', { _csrf: csrfOf(html), palabras: '' })).status, 403);

  // Mi cuenta: saldo, inversiones y comentarios con su estado.
  const account = await (await get('/mi-cuenta', { headers: { cookie: v1 } })).text();
  assert.match(account, /class="wallet-big">0/); assert.match(account, /30 Imagos/); assert.match(account, /Oculto por IMAGO/);
  console.log('Fase 6 OK: inversión concurrente sin saldo negativo, doble clic, autoría, fechas y flags, flujo sin cuenta, comentarios, filtro, límite por hora, moderación previa, reportes y panel de moderación.');
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  try {
    const ids = Object.values(users).map(u => u.id);
    for (const row of savedConfig) await pool.query('UPDATE configuracion SET valor=$2 WHERE clave=$1', [row.clave, JSON.stringify(row.valor)]);
    await pool.query('DELETE FROM reportes_comentario WHERE usuario_id=ANY($1::bigint[])', [ids]);
    await pool.query('DELETE FROM comentarios WHERE usuario_id=ANY($1::bigint[]) OR investigacion_id=ANY($2::bigint[])', [ids, items.map(i => i.id)]);
    await pool.query('DELETE FROM inversiones WHERE usuario_id=ANY($1::bigint[])', [ids]);
    await pool.query('DELETE FROM visitas WHERE investigacion_id=ANY($1::bigint[])', [items.map(i => i.id)]);
    await pool.query('DELETE FROM investigaciones WHERE id=ANY($1::bigint[])', [items.map(i => i.id)]);
    await pool.query("DELETE FROM sesiones WHERE sess->>'userId'=ANY($1::text[])", [ids.map(String)]);
    await pool.query('DELETE FROM usuarios WHERE id=ANY($1::bigint[])', [ids]);
    if (program) await pool.query('DELETE FROM programas WHERE id=$1', [program]);
  } finally { await new Promise(resolve => server.close(resolve)); await pool.end(); }
});
