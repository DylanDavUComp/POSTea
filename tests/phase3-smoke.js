require('dotenv').config({ quiet: true });
const assert = require('node:assert/strict');
const sharp = require('sharp');
const app = require('../src/app');
const { pool } = require('../src/db');

const email = 'autor.demo@example.com';
const password = process.env.DEMO_AUTHOR_PASSWORD;
if (!password || process.env.NODE_ENV === 'production') throw new Error('Ejecuta npm run seed:demo en desarrollo antes de esta prueba.');

const server = process.env.POSTEA_TEST_BASE_URL ? null : app.listen(0);
const base = process.env.POSTEA_TEST_BASE_URL || `http://127.0.0.1:${server.address().port}`;
let cookie = '';
const created = [];
let quotaRestore = null;

async function request(path, options = {}) {
  const response = await fetch(base + path, { redirect: 'manual', ...options,
    headers: { ...(options.headers || {}), ...(cookie ? { cookie } : {}) } });
  const setCookie = response.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  return response;
}

async function token(response) {
  const html = await response.text();
  const value = html.match(/name="_csrf" value="([a-f0-9]+)"/)?.[1];
  assert.ok(value, 'el formulario debe incluir CSRF');
  return value;
}

function form(csrf, intent, title, complete = false) {
  const data = new FormData();
  const fields = {
    _csrf: csrf, intent, titulo: title, subtitulo: '',
    pregunta_gancho: complete ? '¿Cómo puede una idea DEMO conectar disciplinas?' : '',
    descripcion: complete ? 'DEMO. Esta descripción permite verificar el envío de una ficha con contenido suficiente para la validación del formulario.' : '',
    objetivo: complete ? 'DEMO. Este objetivo explica lo que busca comprobar la investigación y tiene longitud suficiente para la prueba.' : '',
    metodologia: complete ? 'DEMO. La metodología combina lectura, observación y una revisión de resultados para probar la aplicación.' : '',
    resultados: complete ? 'DEMO. Los resultados muestran una vista previa y confirman que el flujo guarda la ficha enviada correctamente.' : '',
    estado_investigacion: complete ? 'en_desarrollo' : '', tipo: complete ? 'investigacion' : '',
    imagen_credito: 'Imagen DEMO', sharepoint_url: '', investigadores: complete ? 'Investigador DEMO' : ''
  };
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  if (complete) data.set('derechos_imagen_confirmados', 'si');
  return data;
}

async function main() {
  const loginToken = await token(await request('/ingresar'));
  const login = await request('/ingresar', { method: 'POST', body: new URLSearchParams({
    _csrf: loginToken, email, password, next: '/panel'
  }) });
  assert.equal(login.status, 302, 'el autor debe ingresar');
  assert.equal(login.headers.get('location'), '/panel');

  // Deja un solo cupo libre en el programa DEMO para probar el límite de registro (se restaura al final).
  const programId = (await pool.query('SELECT programa_id FROM usuarios WHERE email=$1', [email])).rows[0].programa_id;
  quotaRestore = { programId, cupo: (await pool.query('SELECT cupo FROM programas WHERE id=$1', [programId])).rows[0].cupo };
  const registered = async () => (await pool.query(`SELECT count(*)::int AS n FROM investigaciones
    WHERE programa_id=$1 AND estado_flujo<>'archivada'`, [programId])).rows[0].n;
  await pool.query('UPDATE programas SET cupo=$1 WHERE id=$2', [await registered() + 1, programId]);

  const panel = await request('/panel');
  assert.equal(panel.status, 200);
  assert.match(await panel.text(), /Crear ficha/);
  const anonymousPanel = await fetch(base + '/panel', { redirect: 'manual' });
  assert.equal(anonymousPanel.status, 302, 'el panel no debe ser público');

  const createPage = await request('/panel/investigaciones/nueva');
  const createHtml = await createPage.text();
  assert.match(createHtml, /<form class="editor-form"[^>]*novalidate/, 'el navegador no debe bloquear el envío sin mostrar el error del servidor');
  assert.match(createHtml, /action="\/panel\/investigaciones\/nueva">\s*<input type="hidden" name="_csrf"/, 'la etiqueta form debe cerrar antes del campo CSRF');
  const createToken = createHtml.match(/name="_csrf" value="([a-f0-9]+)"/)?.[1];
  assert.ok(createToken);
  const tooLarge = form(createToken, 'borrador', 'DEMO Imagen demasiado grande');
  tooLarge.set('imagen', new Blob([Buffer.alloc(5 * 1024 * 1024 + 1)], { type: 'image/png' }), 'grande.png');
  const rejectedImage = await request('/panel/investigaciones/nueva', { method: 'POST', body: tooLarge });
  assert.equal(rejectedImage.status, 400, 'la imagen mayor a 5 MB debe rechazarse');
  const title = `DEMO Prueba fase 3 ${Date.now()}`;
  const draft = await request('/panel/investigaciones/nueva', { method: 'POST', body: form(createToken, 'borrador', title) });
  assert.equal(draft.status, 302, 'debe guardar borrador');
  assert.match(draft.headers.get('location'), /resultado=guardada/);
  const id = draft.headers.get('location')?.match(/\/investigaciones\/(\d+)\/vista-previa/)?.[1];
  assert.ok(id);
  created.push(id);

  const fullPanel = await (await request('/panel')).text();
  assert.doesNotMatch(fullPanel, /Crear ficha/, 'con el cupo lleno no se ofrece crear otra ficha');
  assert.match(fullPanel, /solicitarlo a IMAGO por los canales internos/);
  const fullPage = await request('/panel/investigaciones/nueva');
  assert.equal(fullPage.status, 409, 'el formulario nuevo se bloquea con el cupo lleno');
  await fullPage.text();
  const blocked = await request('/panel/investigaciones/nueva', { method: 'POST', body: form(createToken, 'borrador', `DEMO Fuera de cupo ${Date.now()}`) });
  assert.equal(blocked.status, 409, 'no se registra una ficha por encima del cupo');
  assert.match(await blocked.text(), /máximo permitido/);

  const editToken = await token(await request(`/panel/investigaciones/${id}/editar`));
  const tooShort = form(editToken, 'enviar', title, true);
  for (const field of ['descripcion', 'objetivo', 'metodologia', 'resultados']) tooShort.set(field, 'DEMO 123');
  const shortResponse = await request(`/panel/investigaciones/${id}/editar`, { method: 'POST', body: tooShort });
  assert.equal(shortResponse.status, 400, 'las secciones de menos de 80 caracteres deben rechazarse');
  const shortHtml = await shortResponse.text();
  assert.match(shortHtml, /ahora tiene 8/);
  assert.match(shortHtml, /class="form-alert action-error"/, 'el error debe verse junto a los botones');
  const invalidSend = await request(`/panel/investigaciones/${id}/editar`, { method: 'POST',
    body: form(editToken, 'enviar', title, true) });
  assert.equal(invalidSend.status, 400, 'no puede enviarse sin imagen');
  assert.match(await invalidSend.text(), /Agrega una imagen/);

  const image = await sharp({ create: { width: 2200, height: 1100, channels: 3, background: '#FF6B00' } }).png().toBuffer();
  const complete = form(editToken, 'enviar', title, true);
  complete.set('imagen', new Blob([image], { type: 'image/png' }), 'demo.png');
  const sent = await request(`/panel/investigaciones/${id}/editar`, { method: 'POST', body: complete });
  assert.equal(sent.status, 302, 'debe enviar la ficha completa');
  assert.match(sent.headers.get('location'), /resultado=enviada/);
  const row = (await pool.query('SELECT estado_flujo, imagen_mime, slug FROM investigaciones WHERE id=$1', [id])).rows[0];
  assert.equal(row.estado_flujo, 'enviada');
  assert.equal(row.imagen_mime, 'image/webp');
  assert.match(row.slug, /^demo-prueba-fase-3-/);
  const media = await request(`/media/investigaciones/${id}`);
  assert.equal(media.status, 200);
  const anonymousMedia = await fetch(base + `/media/investigaciones/${id}`);
  assert.equal(anonymousMedia.status, 404, 'la imagen de una ficha no publicada debe ser privada');
  const metadata = await sharp(Buffer.from(await media.arrayBuffer())).metadata();
  assert.equal(metadata.format, 'webp');
  assert.equal(metadata.width, 1600);
  const preview = await request(sent.headers.get('location'));
  assert.equal(preview.status, 200);
  const previewHtml = await preview.text();
  assert.match(previewHtml, /Investigador DEMO/);
  assert.match(previewHtml, /La ficha fue enviada para revisión/);

  await pool.query('UPDATE programas SET cupo=cupo+1 WHERE id=$1', [programId]);
  const racing = await Promise.all([1, 2, 3].map(n => request('/panel/investigaciones/nueva', { method: 'POST',
    body: form(createToken, 'borrador', `DEMO Borrador para eliminar ${Date.now()} ${n}`) })));
  const idOf = response => response.headers.get('location')?.match(/\/investigaciones\/(\d+)\/vista-previa/)?.[1];
  for (const response of racing) if (response.status === 302) created.push(idOf(response));
  assert.deepEqual(racing.map(r => r.status).sort(), [302, 409, 409], 'el cupo de registro resiste solicitudes simultáneas');
  await Promise.all(racing.filter(r => r.status !== 302).map(r => r.text()));
  const otherId = idOf(racing.find(r => r.status === 302));
  assert.ok(otherId);
  const deleteToken = await token(await request(`/panel/investigaciones/${otherId}/vista-previa`));
  const deleted = await request(`/panel/investigaciones/${otherId}/eliminar`, { method: 'POST',
    body: new URLSearchParams({ _csrf: deleteToken }) });
  assert.equal(deleted.status, 302);
  assert.equal((await pool.query('SELECT 1 FROM investigaciones WHERE id=$1', [otherId])).rowCount, 0);
  created.pop();
  console.log('Fase 3: borrador, cupo de registro (también simultáneo), validación, envío, WebP, vista previa y eliminación correctos.');
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  for (const id of created) if (id) await pool.query('DELETE FROM investigaciones WHERE id=$1', [id]);
  if (quotaRestore) await pool.query('UPDATE programas SET cupo=$1 WHERE id=$2', [quotaRestore.cupo, quotaRestore.programId]);
  if (server) await new Promise(resolve => server.close(resolve));
  await pool.end();
});
