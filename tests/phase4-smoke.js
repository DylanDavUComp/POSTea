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
const suffix = crypto.randomBytes(8).toString('hex');
const password = crypto.randomBytes(24).toString('base64url');
const programs = [], users = [], items = [];

function browser() {
  let cookie = '';
  return async (path, options = {}) => {
    const response = await fetch(base + path, { redirect: 'manual', ...options, headers: { cookie } });
    if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    return response;
  };
}
function token(html) {
  const value = html.match(/name="_csrf" value="([a-f0-9]+)"/)?.[1];
  assert.ok(value, 'CSRF presente');
  return value;
}
async function login(request, email, next) {
  const csrf = token(await (await request('/ingresar')).text());
  const response = await request('/ingresar', { method: 'POST', body: new URLSearchParams({ _csrf: csrf, email, password, next }) });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), next);
  await response.text();
  const page = await request(next);
  assert.equal(page.status, 200, `GET ${next}: ${page.headers.get('location')}`);
  return token(await page.text());
}
function post(request, path, csrf, data = {}) {
  return request(path, { method: 'POST', body: new URLSearchParams({ _csrf: csrf, ...data }) });
}
async function state(id) { return (await pool.query('SELECT * FROM investigaciones WHERE id=$1', [id])).rows[0]; }

async function main() {
  const faculty = (await pool.query('SELECT id FROM facultades LIMIT 1')).rows[0].id;
  for (let n = 0; n < 2; n++) programs.push((await pool.query('INSERT INTO programas(nombre,facultad_id) VALUES($1,$2) RETURNING id', [`DEMO test fase4 ${suffix} ${n}`, faculty])).rows[0].id);
  const hash = await bcrypt.hash(password, 10);
  for (const [role, status, program] of [['coordinador','activo',programs[0]], ['autor','pendiente',programs[0]], ['admin','activo',null], ['autor','pendiente',programs[0]]]) {
    const email = `fase4-${suffix}-${users.length}@example.com`;
    const user = (await pool.query(`INSERT INTO usuarios(nombre,email,password_hash,rol,estado,tipo_persona,programa_id,acepta_datos_at,acepta_datos_version)
      VALUES('DEMO prueba fase4',$1,$2,$3,$4,'docente',$5,now(),'prueba') RETURNING id,email`, [email,hash,role,status,program])).rows[0];
    users.push(user);
  }
  await pool.query('INSERT INTO coordinadores_programa VALUES($1,$2)', [users[0].id,programs[0]]);
  const image = await sharp({ create: { width: 20, height: 20, channels: 3, background: '#abcdef' } }).webp().toBuffer();
  const text = 'Texto de prueba DEMO para verificar la revisión de las fichas y las transiciones autorizadas de estado.';
  for (let n = 0; n < 5; n++) {
    items.push((await pool.query(`INSERT INTO investigaciones(slug,programa_id,autor_id,titulo,pregunta_gancho,descripcion,objetivo,metodologia,resultados,
      estado_investigacion,tipo,imagen,imagen_mime,derechos_imagen_confirmados,estado_flujo)
      VALUES($1,$2,$3,'DEMO revisión','Pregunta DEMO',$4,$4,$4,$4,'en_desarrollo','investigacion',$5,'image/webp',true,'enviada') RETURNING id`,
      [`demo-fase4-${suffix}-${n}`,programs[n === 4 ? 1 : 0],users[1].id,text,image])).rows[0].id);
  }
  const coordinator = browser(), admin = browser(), author = browser();
  const csrf = await login(coordinator, users[0].email, '/coordinacion');
  assert.equal((await post(coordinator, `/coordinacion/autores/${users[1].id}/activar`, csrf)).status, 302);
  assert.equal((await pool.query('SELECT estado FROM usuarios WHERE id=$1', [users[1].id])).rows[0].estado, 'activo');
  assert.equal((await post(coordinator, `/coordinacion/autores/${users[1].id}/activar`, csrf)).status, 409);
  assert.equal((await post(coordinator, `/coordinacion/autores/${users[3].id}/rechazar`, csrf)).status, 302);
  assert.equal((await pool.query('SELECT estado FROM usuarios WHERE id=$1', [users[3].id])).rows[0].estado, 'bloqueado');
  assert.equal((await coordinator(`/coordinacion/investigaciones/${items[0]}`)).status, 200);
  assert.equal((await coordinator(`/media/investigaciones/${items[0]}`)).status, 200);
  assert.equal((await coordinator(`/coordinacion/investigaciones/${items[4]}`)).status, 404);
  assert.equal((await coordinator(`/media/investigaciones/${items[4]}`)).status, 404);
  assert.equal((await post(coordinator, `/coordinacion/investigaciones/${items[4]}/seleccionar`, csrf)).status, 403);
  assert.equal((await post(coordinator, `/coordinacion/investigaciones/${items[0]}/seleccionar`, 'invalid')).status, 403);
  const results = await Promise.all(items.slice(0,4).map(id => post(coordinator, `/coordinacion/investigaciones/${id}/seleccionar`, csrf)));
  assert.deepEqual(results.map(r => r.status).sort(), [302,302,302,409], 'el cupo resiste cuatro solicitudes simultáneas');
  let selected = (await pool.query("SELECT id FROM investigaciones WHERE programa_id=$1 AND estado_flujo='seleccionada' ORDER BY id", [programs[0]])).rows;
  assert.equal(selected.length, 3);
  const returned = selected[0].id;
  assert.equal((await post(coordinator, `/coordinacion/investigaciones/${returned}/devolver`, csrf, { observaciones: 'corto' })).status, 400);
  assert.equal((await post(coordinator, `/coordinacion/investigaciones/${returned}/devolver`, csrf, { observaciones: 'Amplía los resultados y explica los hallazgos.' })).status, 302);
  assert.equal((await state(returned)).estado_flujo, 'devuelta');
  await login(author, users[1].email, '/mi-cuenta');
  const edit = await author(`/panel/investigaciones/${returned}/editar`);
  assert.equal(edit.status, 200, 'una ficha devuelta vuelve a ser editable');
  assert.match(await (await author('/panel')).text(), /Amplía los resultados/);
  assert.equal((await author('/coordinacion')).status, 403);
  const adminCsrf = await login(admin, users[2].email, '/admin/investigaciones');
  const publishId = selected[1].id;
  const territory = (await pool.query('SELECT id FROM territorios LIMIT 1')).rows[0].id;
  assert.equal((await post(coordinator, `/admin/investigaciones/${publishId}/publicar`, csrf, { territorio_id: territory })).status, 403);
  assert.equal((await post(admin, `/admin/investigaciones/${returned}/publicar`, adminCsrf, { territorio_id: territory })).status, 409);
  assert.equal((await post(admin, `/admin/investigaciones/${publishId}/publicar`, adminCsrf)).status, 400);
  const slug = (await state(publishId)).slug;
  assert.equal((await post(admin, `/admin/investigaciones/${publishId}/publicar`, adminCsrf, { territorio_id: territory })).status, 302);
  const published = await state(publishId);
  assert.equal(published.estado_flujo, 'publicada');
  assert.equal(published.territorio_id, territory);
  assert.ok(published.publicada_at);
  assert.equal(published.slug, slug);
  await assert.rejects(pool.query('UPDATE investigaciones SET slug=$1 WHERE id=$2', [`nuevo-${suffix}`,publishId]), /slug/);
  assert.equal((await post(admin, `/admin/investigaciones/${publishId}/archivar`, adminCsrf)).status, 302);
  assert.equal((await state(publishId)).estado_flujo, 'archivada');
  await assert.rejects(pool.query('UPDATE investigaciones SET slug=$1 WHERE id=$2', [`nuevo-${suffix}`,publishId]), /slug/);
  assert.equal((await fetch(base + `/media/investigaciones/${publishId}`)).status, 404);
  const remaining = items.slice(0,4).find(id => !selected.some(s => s.id === id));
  assert.equal((await post(coordinator, `/coordinacion/investigaciones/${remaining}/seleccionar`, csrf)).status, 302, 'devolver y archivar liberan cupo');
  console.log('Fase 4 OK: activación/rechazo, permisos, CSRF, revisión privada, cupo concurrente, devolución editable, publicación, slug fijo y archivo.');
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  try {
    await pool.query('DELETE FROM investigaciones WHERE id=ANY($1::bigint[])', [items]);
    await pool.query("DELETE FROM sesiones WHERE sess->>'userId'=ANY($1::text[])", [users.map(u => String(u.id))]);
    await pool.query('DELETE FROM usuarios WHERE id=ANY($1::bigint[])', [users.map(u => u.id)]);
    await pool.query('DELETE FROM programas WHERE id=ANY($1::bigint[])', [programs]);
  } finally { await new Promise(resolve => server.close(resolve)); await pool.end(); }
});
