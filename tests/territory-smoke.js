// Territorio elegido por el autor al registrar la ficha (existente u «Otro») y creado por IMAGO al publicar.
require('dotenv').config({ quiet: true });
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const bcrypt = require('bcrypt');
const sharp = require('sharp');
if (process.env.NODE_ENV === 'production') throw new Error('Prueba reservada a desarrollo.');
const app = require('../src/app');
const { pool } = require('../src/db');
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
const suffix = crypto.randomBytes(5).toString('hex');
const password = crypto.randomBytes(16).toString('hex');
const ids = { users: [], programs: [], territories: [] };
let savedConfig = [];

const get = (path, options = {}) => fetch(base + path, { redirect: 'manual', ...options });
const csrfOf = html => html.match(/name="_csrf" value="([a-f0-9]+)"/)[1];
async function login(email, secret = password) {
  const page = await get('/ingresar');
  const cookie = page.headers.get('set-cookie').split(';')[0];
  const res = await get('/ingresar', { method: 'POST', headers: { cookie }, body: new URLSearchParams({ _csrf: csrfOf(await page.text()), email, password: secret }) });
  assert.equal(res.status, 302, `ingreso ${email}`);
  return res.headers.get('set-cookie').split(';')[0];
}
const text = 'DEMO. Texto con longitud suficiente para pasar la validación de envío de la ficha en la prueba de territorio.';
async function sendForm(cookie, path, fields, withImage = true) {
  const csrf = csrfOf(await (await get(path, { headers: { cookie } })).text());
  const data = new FormData();
  const all = { _csrf: csrf, titulo: `DEMO territorio ${suffix}`, subtitulo: '', pregunta_gancho: '¿Dónde vive esta idea?', descripcion: text,
    objetivo: text, metodologia: text, resultados: text, estado_investigacion: 'terminada', tipo: 'investigacion', imagen_credito: '',
    investigadores: 'Investigadora DEMO', derechos_imagen_confirmados: 'si', territorio: '', territorio_otro: '', intent: 'enviar', ...fields };
  for (const [key, value] of Object.entries(all)) data.set(key, value);
  if (withImage) data.set('imagen', new Blob([await sharp({ create: { width: 3000, height: 2800, channels: 3, background: '#2a1150' } }).png().toBuffer()], { type: 'image/png' }), 'demo.png');
  const res = await get(path, { method: 'POST', headers: { cookie }, body: data });
  return { status: res.status, location: res.headers.get('location'), html: await res.text() };
}
const idFrom = location => Number(location.match(/investigaciones\/(\d+)\//)[1]);
const row = async id => (await pool.query('SELECT * FROM investigaciones WHERE id=$1', [id])).rows[0];
async function publish(cookie, id, territorio_id) {
  const csrf = csrfOf(await (await get('/admin/investigaciones', { headers: { cookie } })).text());
  return get(`/admin/investigaciones/${id}/publicar`, { method: 'POST', headers: { cookie }, body: new URLSearchParams({ _csrf: csrf, territorio_id }) });
}

async function main() {
  // Convocatoria abierta durante la prueba; se restaura al final.
  savedConfig = (await pool.query("SELECT clave, valor FROM configuracion WHERE clave IN ('fecha_apertura','fecha_cierre')")).rows;
  const day = 24 * 60 * 60 * 1000;
  await pool.query("UPDATE configuracion SET valor=to_jsonb($1::text) WHERE clave='fecha_apertura'", [new Date(Date.now() - day).toISOString()]);
  await pool.query("UPDATE configuracion SET valor=to_jsonb($1::text) WHERE clave='fecha_cierre'", [new Date(Date.now() + day).toISOString()]);

  const faculty = (await pool.query('SELECT id FROM facultades ORDER BY orden LIMIT 1')).rows[0].id;
  const existing = (await pool.query('SELECT id, nombre FROM territorios ORDER BY orden LIMIT 1')).rows[0];
  const program = (await pool.query('INSERT INTO programas(nombre,facultad_id,cupo) VALUES($1,$2,10) RETURNING id', [`DEMO territorio ${suffix}`, faculty])).rows[0].id;
  ids.programs.push(program);
  const author = (await pool.query(`INSERT INTO usuarios(nombre,email,password_hash,rol,estado,tipo_persona,programa_id,acepta_datos_at,acepta_datos_version)
    VALUES('Autora DEMO',$1,$2,'autor','activo','investigador',$3,now(),'prueba') RETURNING id,email`,
  [`territorio-${suffix}@example.com`, await bcrypt.hash(password, 10), program])).rows[0];
  ids.users.push(author.id);
  const authorCookie = await login(author.email);
  const admin = await login(process.env.ADMIN_EMAIL, process.env.ADMIN_PASSWORD);

  // 1. El formulario ofrece los territorios y «Otro», y el título de cada sección es parte del recuadro.
  const form = await (await get('/panel/investigaciones/nueva', { headers: { cookie: authorCookie } })).text();
  assert.match(form, /<select id="territorio" name="territorio"/);
  assert.ok(form.includes(`<option value="${existing.id}" >${existing.nombre}</option>`), 'territorios existentes');
  assert.match(form, /<option value="otro" >Otro<\/option>/);
  assert.match(form, /id="territorio_otro" name="territorio_otro"/);
  assert.doesNotMatch(form, /sharepoint_url/, 'sin campo de PDF');

  // 2. Para enviar, el territorio es obligatorio; «Otro» exige escribir cuál. El borrador puede quedar sin territorio.
  assert.match((await sendForm(authorCookie, '/panel/investigaciones/nueva', {})).html, /Selecciona el territorio de tu investigación/);
  assert.match((await sendForm(authorCookie, '/panel/investigaciones/nueva', { territorio: 'otro', territorio_otro: 'ab' })).html, /Escribe el nombre del territorio/);
  assert.match((await sendForm(authorCookie, '/panel/investigaciones/nueva', { territorio: '999999999' })).html, /Selecciona un territorio válido/);
  const draft = await sendForm(authorCookie, '/panel/investigaciones/nueva', { intent: 'borrador' }, false);
  assert.equal(draft.status, 302, 'borrador sin territorio');
  const draftId = idFrom(draft.location);
  assert.equal((await row(draftId)).territorio_id, null);

  // 3. Con un territorio existente: queda guardado, se ve en la vista previa y llega preseleccionado a IMAGO.
  const chosen = await sendForm(authorCookie, '/panel/investigaciones/nueva', { territorio: String(existing.id) });
  assert.equal(chosen.status, 302, chosen.html.match(/form-alert[^>]*>([^<]*)/)?.[1]);
  const chosenId = idFrom(chosen.location);
  assert.equal(String((await row(chosenId)).territorio_id), String(existing.id));
  assert.ok((await (await get(chosen.location, { headers: { cookie: authorCookie } })).text()).includes(`<strong>Territorio:</strong> ${existing.nombre}`));
  let review = await (await get('/admin/investigaciones', { headers: { cookie: admin } })).text();
  const block = id => review.slice(review.indexOf(`id="territorio-${id}"`), review.indexOf('</select>', review.indexOf(`id="territorio-${id}"`)));
  assert.match(block(chosenId), new RegExp(`<option value="${existing.id}" selected>`), 'preseleccionado para IMAGO');
  assert.equal((await publish(admin, chosenId, String(existing.id))).status, 302);
  assert.equal((await row(chosenId)).estado_flujo, 'publicada');

  // 4. «Otro»: se guarda el nombre propuesto; IMAGO lo ve como «Crear …» y al publicar se crea el territorio.
  const proposed = `Territorio DEMO ${suffix}`;
  const other = await sendForm(authorCookie, '/panel/investigaciones/nueva', { territorio: 'otro', territorio_otro: proposed });
  assert.equal(other.status, 302);
  const otherId = idFrom(other.location);
  assert.deepEqual([(await row(otherId)).territorio_id, (await row(otherId)).territorio_propuesto], [null, proposed]);
  // Al editar, el formulario recuerda «Otro» y el nombre escrito.
  await pool.query("UPDATE investigaciones SET estado_flujo='devuelta' WHERE id=$1", [otherId]);
  const edit = await (await get(`/panel/investigaciones/${otherId}/editar`, { headers: { cookie: authorCookie } })).text();
  assert.match(edit, /<option value="otro" selected>Otro<\/option>/); assert.ok(edit.includes(`value="${proposed}"`));
  await pool.query("UPDATE investigaciones SET estado_flujo='enviada' WHERE id=$1", [otherId]);
  review = await (await get('/admin/investigaciones', { headers: { cookie: admin } })).text();
  assert.ok(block(otherId).includes(`<option value="nuevo" selected>Crear «${proposed}» (propuesto por el autor)</option>`));
  assert.equal((await publish(admin, otherId, 'nuevo')).status, 302);
  const created = (await pool.query('SELECT id, nombre FROM territorios WHERE nombre=$1', [proposed])).rows[0];
  assert.ok(created, 'territorio creado al publicar');
  ids.territories.push(created.id);
  const published = await row(otherId);
  assert.deepEqual([published.estado_flujo, String(published.territorio_id), published.territorio_propuesto], ['publicada', String(created.id), null]);
  assert.ok((await (await get(`/muro?territorio=${created.id}`)).text()).includes(`/f/${published.slug}`), 'aparece en el muro bajo el territorio nuevo');

  // 5. Otro autor propone el mismo nombre con otras mayúsculas y tildes: se reutiliza, no se duplica.
  const again = await sendForm(authorCookie, '/panel/investigaciones/nueva', { territorio: 'otro', territorio_otro: proposed.toUpperCase().replace('TERRITORIO', 'TERRITÓRIO') });
  const againId = idFrom(again.location);
  assert.equal((await publish(admin, againId, 'nuevo')).status, 302);
  assert.equal(String((await row(againId)).territorio_id), String(created.id));
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM territorios WHERE id=$1 OR nombre ILIKE $2', [created.id, `%DEMO ${suffix}`])).rows[0].n, 1);

  // 6. En una ficha publicada con edición autorizada, el territorio se muestra pero no se cambia.
  await pool.query('UPDATE investigaciones SET edicion_autorizada_at=now() WHERE id=$1', [chosenId]);
  const editPublished = await (await get(`/panel/investigaciones/${chosenId}/editar`, { headers: { cookie: authorCookie } })).text();
  assert.doesNotMatch(editPublished, /name="territorio"/); assert.ok(editPublished.includes(`<strong>Territorio:</strong> ${existing.nombre}`));

  console.log('Territorio OK: el autor elige un territorio existente u «Otro» (obligatorio para enviar, opcional en borrador), IMAGO lo recibe preseleccionado, «Otro» se crea al publicar sin duplicados y no se cambia al editar una ficha publicada.');
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  try {
    for (const { clave, valor } of savedConfig) await pool.query('UPDATE configuracion SET valor=$1 WHERE clave=$2', [JSON.stringify(valor), clave]);
    await pool.query('DELETE FROM visitas WHERE investigacion_id IN (SELECT id FROM investigaciones WHERE programa_id=ANY($1::bigint[]))', [ids.programs]);
    await pool.query('DELETE FROM investigaciones WHERE programa_id=ANY($1::bigint[])', [ids.programs]);
    await pool.query('DELETE FROM territorios WHERE id=ANY($1::bigint[])', [ids.territories]);
    await pool.query("DELETE FROM sesiones WHERE sess->>'userId'=ANY($1::text[])", [ids.users.map(String)]);
    await pool.query('DELETE FROM usuarios WHERE id=ANY($1::bigint[])', [ids.users]);
    await pool.query('DELETE FROM programas WHERE id=ANY($1::bigint[])', [ids.programs]);
  } finally { await new Promise(resolve => server.close(resolve)); await pool.end(); }
});
