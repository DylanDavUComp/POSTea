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
const ids = { users: [], programs: [], items: [] };
const text = n => `Texto DEMO ${n} `.repeat(12).trim();

const get = (path, options = {}) => fetch(base + path, { redirect: 'manual', ...options });
const csrfOf = html => html.match(/name="_csrf" value="([a-f0-9]+)"/)[1];
async function login(email, secret = password) {
  const page = await get('/ingresar');
  const cookie = page.headers.get('set-cookie').split(';')[0];
  const res = await get('/ingresar', { method: 'POST', headers: { cookie }, body: new URLSearchParams({ _csrf: csrfOf(await page.text()), email, password: secret }) });
  assert.equal(res.status, 302, `ingreso ${email}`);
  return res.headers.get('set-cookie').split(';')[0];
}
async function adminAction(cookie, id, action, fields = {}) {
  const csrf = csrfOf(await (await get('/admin/investigaciones', { headers: { cookie } })).text());
  const res = await get(`/admin/investigaciones/${id}/${action}`, { method: 'POST', headers: { cookie }, body: new URLSearchParams({ _csrf: csrf, ...fields }) });
  return { status: res.status, location: res.headers.get('location'), html: await res.text() };
}
const row = async id => (await pool.query('SELECT * FROM investigaciones WHERE id=$1', [id])).rows[0];
async function insertResearch({ program, author, state, territory = null, title }) {
  const image = await sharp({ create: { width: 40, height: 30, channels: 3, background: '#2a1150' } }).webp().toBuffer();
  const item = (await pool.query(`INSERT INTO investigaciones(slug,programa_id,territorio_id,autor_id,titulo,pregunta_gancho,descripcion,objetivo,metodologia,resultados,
    estado_investigacion,tipo,imagen,imagen_mime,derechos_imagen_confirmados,estado_flujo,publicada_at)
    VALUES($1,$2,$3,$4,$5,'¿Pregunta DEMO?',$6,$6,$6,$6,'terminada','investigacion',$7,'image/webp',true,$8,$9) RETURNING id,slug`,
  [`pub-${suffix}-${ids.items.length}`, program, territory, author, title, text('base'), image, state, state === 'publicada' ? new Date() : null])).rows[0];
  await pool.query("INSERT INTO investigadores(investigacion_id,nombre_completo) VALUES($1,'Ana Original')", [item.id]);
  ids.items.push(item.id);
  return item;
}

async function main() {
  const faculty = (await pool.query('SELECT id FROM facultades ORDER BY orden LIMIT 1')).rows[0].id;
  const territory = (await pool.query('SELECT id FROM territorios ORDER BY orden LIMIT 1')).rows[0].id;
  const program = (await pool.query('INSERT INTO programas(nombre,facultad_id,cupo) VALUES($1,$2,3) RETURNING id', [`DEMO pub ${suffix}`, faculty])).rows[0].id;
  const small = (await pool.query('INSERT INTO programas(nombre,facultad_id,cupo) VALUES($1,$2,1) RETURNING id', [`DEMO pub cupo1 ${suffix}`, faculty])).rows[0].id;
  ids.programs.push(program, small);
  const hash = await bcrypt.hash(password, 10);
  const author = (await pool.query(`INSERT INTO usuarios(nombre,email,password_hash,rol,estado,tipo_persona,programa_id,acepta_datos_at,acepta_datos_version)
    VALUES('Autora DEMO',$1,$2,'autor','activo','investigador',$3,now(),'prueba') RETURNING id,email`, [`pub-autor-${suffix}@example.com`, hash, program])).rows[0];
  ids.users.push(author.id);
  const admin = await login(process.env.ADMIN_EMAIL, process.env.ADMIN_PASSWORD);
  const authorCookie = await login(author.email);

  // 1. Aprobar = publicar en un paso, directamente desde «enviada».
  const sent = await insertResearch({ program, author: author.id, state: 'enviada', title: `DEMO enviada ${suffix}` });
  const list = await (await get('/admin/investigaciones', { headers: { cookie: admin } })).text();
  assert.match(list, new RegExp(`/admin/investigaciones/${sent.id}/publicar`)); assert.match(list, /Aprobar y publicar/);
  assert.equal((await adminAction(admin, sent.id, 'publicar')).status, 400, 'territorio obligatorio');
  let r = await adminAction(admin, sent.id, 'publicar', { territorio_id: territory });
  assert.equal(r.location, '/admin/investigaciones?resultado=publicada');
  assert.equal((await row(sent.id)).estado_flujo, 'publicada');
  assert.equal((await get(`/f/${sent.slug}`)).status, 200, 'queda pública de inmediato');
  assert.ok((await (await get(`/muro?q=${suffix}`)).text()).includes(`/f/${sent.slug}`), 'y aparece en el muro');
  assert.match(await (await get('/admin/investigaciones?resultado=publicada', { headers: { cookie: admin } })).text(), /aprobada y publicada/);
  // También desde «seleccionada» (si coordinación ya la había seleccionado).
  const selected = await insertResearch({ program, author: author.id, state: 'seleccionada', title: `DEMO seleccionada ${suffix}` });
  assert.equal((await adminAction(admin, selected.id, 'publicar', { territorio_id: territory })).status, 302);
  // Devolver desde la misma página.
  const toReturn = await insertResearch({ program, author: author.id, state: 'enviada', title: `DEMO devolver ${suffix}` });
  assert.equal((await adminAction(admin, toReturn.id, 'devolver', { observaciones: 'corto' })).status, 400);
  assert.equal((await adminAction(admin, toReturn.id, 'devolver', { observaciones: 'Ajusta la metodología, por favor.' })).status, 302);
  assert.equal((await row(toReturn.id)).estado_flujo, 'devuelta');
  assert.equal((await adminAction(admin, toReturn.id, 'publicar', { territorio_id: territory })).status, 409, 'una devuelta no se aprueba');
  // El cupo del programa se respeta al aprobar directamente.
  await insertResearch({ program: small, author: author.id, state: 'publicada', territory, title: `DEMO llena ${suffix}` });
  const overflow = await insertResearch({ program: small, author: author.id, state: 'enviada', title: `DEMO excede ${suffix}` });
  assert.match((await adminAction(admin, overflow.id, 'publicar', { territorio_id: territory })).html, /cupo está completo/);
  assert.equal((await row(overflow.id)).estado_flujo, 'enviada');

  // 2. Edición autorizada de una ficha publicada.
  const pub = sent;
  assert.equal((await get(`/panel/investigaciones/${pub.id}/editar`, { headers: { cookie: authorCookie } })).status, 403, 'sin autorización no edita');
  assert.equal((await adminAction(admin, pub.id, 'autorizar-edicion')).location, '/admin/investigaciones?resultado=edicion-autorizada');
  assert.ok((await row(pub.id)).edicion_autorizada_at);
  const panel = await (await get('/panel', { headers: { cookie: authorCookie } })).text();
  assert.match(panel, /Edición autorizada por IMAGO/); assert.match(panel, new RegExp(`/panel/investigaciones/${pub.id}/editar`));
  let form = await (await get(`/panel/investigaciones/${pub.id}/editar`, { headers: { cookie: authorCookie } })).text();
  assert.match(form, /Edición autorizada por IMAGO/); assert.match(form, /Enviar cambios a IMAGO/);
  const submit = async (intent, title, withImage = false) => {
    const page = await (await get(`/panel/investigaciones/${pub.id}/editar`, { headers: { cookie: authorCookie } })).text();
    const data = new FormData();
    for (const [k, v] of Object.entries({ _csrf: csrfOf(page), titulo: title, subtitulo: '', pregunta_gancho: '¿Pregunta nueva?', descripcion: text('nueva'),
      objetivo: text('o'), metodologia: text('m'), resultados: text('r'), estado_investigacion: 'terminada', tipo: 'investigacion', imagen_credito: '',
      sharepoint_url: '', investigadores: 'Ana Original\nBeto Nuevo', derechos_imagen_confirmados: 'si', intent })) data.append(k, v);
    if (withImage) data.append('imagen', new Blob([await sharp({ create: { width: 3000, height: 2800, channels: 3, background: '#ff6b00' } }).png().toBuffer()], { type: 'image/png' }), 'nueva.png');
    const res = await get(`/panel/investigaciones/${pub.id}/editar`, { method: 'POST', headers: { cookie: authorCookie }, body: data });
    await res.text();
    return res;
  };
  const publicImage = Buffer.from(await (await get(`/media/investigaciones/${pub.id}`)).arrayBuffer());
  r = await submit('borrador', `DEMO título nuevo ${suffix}`, true);
  assert.equal(r.headers.get('location'), `/panel/investigaciones/${pub.id}/vista-previa?resultado=cambios-guardados`);
  let current = await row(pub.id);
  assert.equal(current.cambios_estado, 'borrador'); assert.equal(current.titulo, `DEMO enviada ${suffix}`, 'la versión pública no cambia');
  assert.ok((await (await get(`/f/${pub.slug}`)).text()).includes(`DEMO enviada ${suffix}`), 'el público sigue viendo la versión aprobada');
  assert.equal((await get(`/media/investigaciones/${pub.id}/propuesta`, { headers: { cookie: authorCookie } })).status, 200);
  assert.equal((await get(`/media/investigaciones/${pub.id}/propuesta`)).status, 404, 'la imagen propuesta no es pública');
  assert.ok(Buffer.from(await (await get(`/media/investigaciones/${pub.id}`)).arrayBuffer()).equals(publicImage), 'la imagen pública no cambia');
  r = await submit('enviar', `DEMO título nuevo ${suffix}`);
  assert.equal(r.headers.get('location'), `/panel/investigaciones/${pub.id}/vista-previa?resultado=cambios-enviados`);
  assert.equal((await row(pub.id)).cambios_estado, 'enviada');
  assert.ok((await row(pub.id)).cambios_imagen, 'la imagen propuesta se conserva al reenviar sin imagen');
  // Validación completa: una ficha publicada no puede quedar incompleta.
  const page = await (await get(`/panel/investigaciones/${pub.id}/editar`, { headers: { cookie: authorCookie } })).text();
  const bad = new FormData();
  for (const [k, v] of Object.entries({ _csrf: csrfOf(page), titulo: 'X', pregunta_gancho: '', descripcion: 'corta', objetivo: '', metodologia: '', resultados: '',
    estado_investigacion: '', tipo: '', investigadores: '', intent: 'borrador' })) bad.append(k, v);
  r = await get(`/panel/investigaciones/${pub.id}/editar`, { method: 'POST', headers: { cookie: authorCookie }, body: bad });
  assert.equal(r.status, 400); await r.text();
  assert.equal((await row(pub.id)).cambios.titulo, `DEMO título nuevo ${suffix}`, 'una propuesta inválida no reemplaza la anterior');
  // El admin la ve en «Cambios por aprobar» y revisa qué cambió.
  assert.match(await (await get('/admin/investigaciones', { headers: { cookie: admin } })).text(), new RegExp(`/admin/investigaciones/${pub.id}/cambios`));
  const review = await (await get(`/admin/investigaciones/${pub.id}/cambios`, { headers: { cookie: admin } })).text();
  assert.match(review, /Cambios propuestos por el autor:.*Título.*Investigadores.*Imagen/s);
  assert.match(review, new RegExp(`/media/investigaciones/${pub.id}/propuesta`)); assert.match(review, new RegExp(`DEMO título nuevo ${suffix}`));
  assert.equal((await get(`/admin/investigaciones/${pub.id}/cambios`, { headers: { cookie: authorCookie } })).status, 403);
  // Devolver cambios con observaciones; el autor las ve y reenvía.
  assert.equal((await adminAction(admin, pub.id, 'devolver-cambios', { observaciones: 'Revisa la ortografía del título.' })).status, 302);
  assert.equal((await row(pub.id)).cambios_estado, 'devuelta');
  form = await (await get(`/panel/investigaciones/${pub.id}/editar`, { headers: { cookie: authorCookie } })).text();
  assert.match(form, /Revisa la ortografía del título/);
  assert.match(form, new RegExp(`value="DEMO título nuevo ${suffix}"`), 'el formulario parte de la propuesta');
  await submit('enviar', `DEMO título corregido ${suffix}`);
  // Aprobar y publicar los cambios: reemplazan la versión pública sin tocar el enlace.
  r = await adminAction(admin, pub.id, 'aprobar-cambios');
  assert.equal(r.location, '/admin/investigaciones?resultado=cambios-publicados');
  current = await row(pub.id);
  assert.equal(current.titulo, `DEMO título corregido ${suffix}`); assert.equal(current.slug, pub.slug, 'el enlace (y el QR) no cambian');
  assert.equal(current.estado_flujo, 'publicada'); assert.equal(String(current.territorio_id), String(territory));
  assert.equal(current.cambios, null); assert.equal(current.edicion_autorizada_at, null, 'la autorización es de una sola vez');
  const fiche = await (await get(`/f/${pub.slug}`)).text();
  assert.ok(fiche.includes(`DEMO título corregido ${suffix}`) && fiche.includes('Beto Nuevo'), 'el público ve la versión nueva');
  assert.ok(!Buffer.from(await (await get(`/media/investigaciones/${pub.id}`)).arrayBuffer()).equals(publicImage), 'y la imagen nueva');
  assert.equal((await get(`/panel/investigaciones/${pub.id}/editar`, { headers: { cookie: authorCookie } })).status, 403, 'para otra edición se necesita nueva autorización');
  assert.equal((await adminAction(admin, pub.id, 'aprobar-cambios')).status, 409, 'no hay cambios que aprobar');

  // 3. Retirar autorización descarta los cambios; archivar también.
  await adminAction(admin, pub.id, 'autorizar-edicion');
  await submit('enviar', `DEMO descartado ${suffix}`);
  assert.equal((await adminAction(admin, pub.id, 'revocar-edicion')).location, '/admin/investigaciones?resultado=edicion-revocada');
  current = await row(pub.id);
  assert.equal(current.cambios, null); assert.equal(current.titulo, `DEMO título corregido ${suffix}`);
  await adminAction(admin, selected.id, 'autorizar-edicion');
  await pool.query(`UPDATE investigaciones SET cambios='{"titulo":"x"}'::jsonb,cambios_estado='enviada' WHERE id=$1`, [selected.id]);
  assert.equal((await adminAction(admin, selected.id, 'archivar')).status, 302);
  current = await row(selected.id);
  assert.deepEqual([current.estado_flujo, current.cambios, current.edicion_autorizada_at], ['archivada', null, null]);
  assert.equal((await adminAction(admin, toReturn.id, 'autorizar-edicion')).status, 409, 'solo publicadas');
  // Solo el admin autoriza.
  const authorCsrf = csrfOf(await (await get('/panel', { headers: { cookie: authorCookie } })).text());
  assert.equal((await get(`/admin/investigaciones/${pub.id}/autorizar-edicion`, { method: 'POST', headers: { cookie: authorCookie }, body: new URLSearchParams({ _csrf: authorCsrf }) })).status, 403);
  console.log('Publicación OK: aprobar y publicar en un paso (desde enviada o seleccionada), devolver, cupo, edición autorizada con propuesta privada, revisión de cambios, devolución, aprobación sin cambiar el enlace, retiro y archivo.');
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  try {
    await pool.query('DELETE FROM visitas WHERE investigacion_id=ANY($1::bigint[])', [ids.items]);
    await pool.query('DELETE FROM investigaciones WHERE id=ANY($1::bigint[])', [ids.items]);
    await pool.query("DELETE FROM sesiones WHERE sess->>'userId'=ANY($1::text[])", [ids.users.map(String)]);
    await pool.query('DELETE FROM usuarios WHERE id=ANY($1::bigint[])', [ids.users]);
    await pool.query('DELETE FROM programas WHERE id=ANY($1::bigint[])', [ids.programs]);
  } finally { await new Promise(resolve => server.close(resolve)); await pool.end(); }
});
