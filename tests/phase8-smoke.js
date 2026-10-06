require('dotenv').config({ quiet: true });
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const bcrypt = require('bcrypt');
const sharp = require('sharp');
const jsQR = require('jsqr');
if (process.env.NODE_ENV === 'production') throw new Error('Prueba reservada a desarrollo.');
const app = require('../src/app');
const { pool } = require('../src/db');
const { slugFrom } = require('../src/research');
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
const suffix = crypto.randomBytes(5).toString('hex');
const password = crypto.randomBytes(16).toString('hex');
const originalBaseUrl = process.env.BASE_URL;
const RENDER_URL = 'https://postea-imago.onrender.com';
const users = {}, items = [];
let program, otherProgram, savedConfig = [];

const get = (path, options = {}) => fetch(base + path, { redirect: 'manual', ...options });
const csrfOf = html => html.match(/name="_csrf" value="([a-f0-9]+)"/)[1];
async function login(email, secret = password) {
  const page = await get('/ingresar');
  const cookie = page.headers.get('set-cookie').split(';')[0];
  const res = await get('/ingresar', { method: 'POST', headers: { cookie }, body: new URLSearchParams({ _csrf: csrfOf(await page.text()), email, password: secret }) });
  assert.equal(res.status, 302, `ingreso de ${email}`);
  return res.headers.get('set-cookie').split(';')[0];
}
const bytes = async res => Buffer.from(await res.arrayBuffer());
// Decodifica un PNG con un lector de QR real (jsQR).
async function decode(png, size) {
  let image = sharp(png).flatten({ background: '#ffffff' });
  if (size) image = image.resize(size, size, { fit: 'contain', background: '#ffffff' }).blur(0.6);
  const { data, info } = await image.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return jsQR(new Uint8ClampedArray(data), info.width, info.height)?.data || null;
}
// Igual que la confirmación del admin: guarda también la URL exacta confirmada (BASE_URL vigente).
const setUrlConfirmed = value => pool.query(`INSERT INTO configuracion(clave,valor) VALUES('url_qr_confirmada',$1::jsonb),('url_qr_confirmada_para',$2::jsonb)
  ON CONFLICT (clave) DO UPDATE SET valor=EXCLUDED.valor`, [JSON.stringify(value), JSON.stringify(value ? (process.env.BASE_URL || '').replace(/\/+$/, '') : null)]);

async function main() {
  savedConfig = (await pool.query('SELECT clave,valor FROM configuracion')).rows;
  const faculty = (await pool.query('SELECT id FROM facultades ORDER BY orden LIMIT 1')).rows[0];
  const territory = (await pool.query('SELECT id,nombre FROM territorios ORDER BY orden LIMIT 1')).rows[0];
  program = (await pool.query('INSERT INTO programas(nombre,facultad_id) VALUES($1,$2) RETURNING id', [`DEMO f8 ${suffix}`, faculty.id])).rows[0].id;
  otherProgram = (await pool.query('INSERT INTO programas(nombre,facultad_id) VALUES($1,$2) RETURNING id', [`DEMO f8 otro ${suffix}`, faculty.id])).rows[0].id;
  const hash = await bcrypt.hash(password, 10);
  for (const [key, rol, programId] of [['autor', 'autor', program], ['coord', 'coordinador', null], ['otroCoord', 'coordinador', null], ['visitante', 'visitante', null]]) {
    users[key] = (await pool.query(`INSERT INTO usuarios(nombre,email,password_hash,rol,estado,tipo_persona,programa_id,acepta_datos_at,acepta_datos_version)
      VALUES($1,$2,$3,$4,'activo','docente',$5,now(),'prueba') RETURNING id,email`, [`DEMO f8 ${key}`, `f8-${key.toLowerCase()}-${suffix}@example.com`, hash, rol, programId])).rows[0];
  }
  await pool.query('INSERT INTO coordinadores_programa(usuario_id,programa_id) VALUES($1,$2),($3,$4)', [users.coord.id, program, users.otroCoord.id, otherProgram]);
  const image = await sharp({ create: { width: 40, height: 30, channels: 3, background: '#5b2a9e' } }).webp().toBuffer();
  const longTitle = 'Ciudades más caminables para el bienestar urbano de Bogotá y sus localidades';
  for (const [n, estado] of [[0, 'publicada'], [1, 'publicada'], [2, 'seleccionada']]) {
    const slug = n === 0 ? slugFrom(longTitle) : `f8-${suffix}-${n}`;
    items.push((await pool.query(`INSERT INTO investigaciones(slug,programa_id,territorio_id,autor_id,titulo,pregunta_gancho,descripcion,objetivo,metodologia,resultados,
      estado_investigacion,tipo,imagen,imagen_mime,estado_flujo,publicada_at) VALUES($1,$2,$3,$4,$5,$6,'D','O','M','R','terminada','investigacion',$7,'image/webp',$8,$9) RETURNING id,slug`,
    [slug, program, estado === 'publicada' ? territory.id : null, users.autor.id, n === 0 ? longTitle.slice(0, 90) : `DEMO f8 ${n}`,
      `¿Cómo caminamos la ciudad ${n}?`, image, estado, estado === 'publicada' ? new Date() : null])).rows[0]);
    await pool.query('INSERT INTO investigadores(investigacion_id,nombre_completo,orden) VALUES($1,$2,0),($1,$3,1)', [items[n].id, `María Rojas ${suffix}`, 'Juan Pérez']);
  }

  // Slugs cortos: máx. 40 caracteres + sufijo, cortados en palabra completa.
  assert.match(items[0].slug, /^ciudades-mas-caminables-para-el-[0-9a-f]{6}$/);
  assert.ok(slugFrom('a'.repeat(90)).length <= 47);
  assert.match(slugFrom('Hola'), /^hola-[0-9a-f]{6}$/);

  const admin = await login(process.env.ADMIN_EMAIL, process.env.ADMIN_PASSWORD);
  const author = await login(users.autor.email), coord = await login(users.coord.email);
  const otherCoord = await login(users.otroCoord.email), visitor = await login(users.visitante.email);
  const [a, b, c] = items;

  // Botón de inicio en el encabezado.
  assert.match(await (await get('/muro')).text(), /class="nav-home" href="\/"/);

  // Provisional con BASE_URL local: bandas en PNG y SVG, pero el QR sigue decodificando (para probarlo).
  process.env.BASE_URL = 'http://localhost:3000';
  await setUrlConfirmed(true);
  let res = await get(`/investigaciones/${a.id}/qr.png?descargar=1`, { headers: { cookie: admin } });
  assert.equal(res.status, 200); assert.match(res.headers.get('content-disposition'), /PROVISIONAL\.png/);
  let png = await bytes(res);
  let meta = await sharp(png).metadata();
  assert.equal(meta.width, 1200); assert.ok(meta.height > 1200, 'bandas de provisional');
  assert.equal(await decode(png), `http://localhost:3000/f/${a.slug}?src=qr`);
  assert.match(await (await get(`/investigaciones/${a.id}/qr.svg`, { headers: { cookie: admin } })).text(), /QR PROVISIONAL – NO IMPRIMIR/);
  let pieceHtml = await (await get(`/admin/impresion/${a.id}`, { headers: { cookie: admin } })).text();
  assert.match(pieceHtml, /class="sheet-watermark"/); assert.match(pieceHtml, /BASE_URL apunta a localhost/);

  // URL definitiva confirmada: sin marca, 1200 px exactos, nivel Q, apunta a BASE_URL + slug.
  process.env.BASE_URL = RENDER_URL;
  await setUrlConfirmed(false);
  pieceHtml = await (await get(`/admin/impresion/${a.id}`, { headers: { cookie: admin } })).text();
  assert.match(pieceHtml, /la URL de los QR no está confirmada/);
  await setUrlConfirmed(true);
  png = await bytes(await get(`/investigaciones/${a.id}/qr.png`, { headers: { cookie: admin } }));
  meta = await sharp(png).metadata();
  assert.deepEqual([meta.width, meta.height], [1200, 1200]);
  const expected = `${RENDER_URL}/f/${a.slug}?src=qr`;
  assert.equal(await decode(png), expected, 'el QR decodifica a la URL exacta');
  // El QR se genera al vuelo: cambiar BASE_URL cambia el QR sin tocar la base.
  process.env.BASE_URL = 'https://otra-url.example.org';
  assert.equal(await decode(await bytes(await get(`/investigaciones/${a.id}/qr.png`, { headers: { cookie: admin } }))), `https://otra-url.example.org/f/${a.slug}?src=qr`);
  process.env.BASE_URL = RENDER_URL;
  // Criterio de aceptación: un QR de 8 cm visto a 1 m con la cámara de un celular (~12 MP, 70°) ocupa unos 230 px.
  // Se reduce a ese tamaño con desenfoque y debe seguir leyéndose.
  assert.equal(await decode(png, 230), expected, 'QR de 8 cm legible a 1 m (simulado)');
  const svg = await (await get(`/investigaciones/${a.id}/qr.svg?descargar=1`, { headers: { cookie: admin } })).text();
  assert.match(svg, /^<svg[^>]+viewBox/); assert.doesNotMatch(svg, /PROVISIONAL/);
  assert.equal(await decode(await sharp(Buffer.from(svg)).resize(800).png().toBuffer()), expected, 'el SVG también decodifica');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name='investigaciones' AND column_name ILIKE '%qr%' AND column_name<>'qr_verificado_at'")).rows[0].n, 0, 'el QR no se guarda');

  // Pieza de medio pliego.
  pieceHtml = await (await get(`/admin/impresion/${a.id}`, { headers: { cookie: admin } })).text();
  assert.doesNotMatch(pieceHtml, /class="sheet-watermark"/);
  // Diseño de post IMAGO: título en la franja azul, investigadores, QR y llamado a la acción; el territorio va en el rótulo de pantalla.
  for (const text of ['<b>Escanea</b> <span>y conoce la</span> <b>investigación</b>', longTitle.slice(0, 90), `María Rojas ${suffix} · Juan Pérez`, territory.nombre, 'UCompensar',
    'Imagen de referencia. Diseño sujeto a ajustes.', 'Probar QR', `href="${expected}"`]) {
    assert.ok(pieceHtml.includes(text), `pieza incluye ${text}`);
  }
  assert.match(pieceHtml, /<div class="ig-post-qr"><svg/); assert.match(pieceHtml, /class="ig-post-bar"/); assert.match(pieceHtml, /class="ig-post-band"/);
  // La seleccionada sin publicar sigue provisional.
  assert.match(await (await get(`/admin/impresion/${c.id}`, { headers: { cookie: admin } })).text(), /la ficha aún no está publicada/);

  // Permisos: admin, autor y coordinación del programa; nadie más.
  assert.equal((await get(`/investigaciones/${a.id}/pieza`, { headers: { cookie: author } })).status, 200);
  assert.equal((await get(`/investigaciones/${a.id}/pieza`, { headers: { cookie: coord } })).status, 200);
  for (const cookie of [otherCoord, visitor]) {
    assert.equal((await get(`/investigaciones/${a.id}/pieza`, { headers: { cookie } })).status, 404);
    assert.equal((await get(`/investigaciones/${a.id}/qr.png`, { headers: { cookie } })).status, 404);
  }
  assert.equal((await get(`/investigaciones/${a.id}/qr.png`)).status, 302, 'sin sesión pide ingresar');
  assert.equal((await get(`/admin/impresion/${a.id}`, { headers: { cookie: author } })).status, 403);
  assert.equal((await get(`/investigaciones/${a.id}/qr.gif`, { headers: { cookie: admin } })).status, 404);
  const preview = await (await get(`/panel/investigaciones/${a.id}/vista-previa`, { headers: { cookie: author } })).text();
  assert.match(preview, new RegExp(`/investigaciones/${a.id}/pieza`)); assert.match(preview, new RegExp(`/investigaciones/${a.id}/qr.svg`));

  // Lote y listado.
  const list = await (await get('/admin/impresion', { headers: { cookie: admin } })).text();
  for (const item of items) assert.match(list, new RegExp(`/admin/impresion/${item.id}"`));
  const batch = await (await get(`/admin/impresion/lote?id=${a.id}&id=${c.id}&id=abc`, { headers: { cookie: admin } })).text();
  assert.equal(batch.match(/<article class="sheet /g).length, 2); assert.match(batch, /1 de 2 piezas/);
  const all = await (await get('/admin/impresion/lote?todas=1', { headers: { cookie: admin } })).text();
  const inBatch = item => all.includes(`/media/investigaciones/${item.id}"`);
  assert.ok(inBatch(a) && inBatch(b) && !inBatch(c), 'todas = solo publicadas');
  assert.equal((await get('/admin/impresion/lote', { headers: { cookie: admin } })).headers.get('location'), '/admin/impresion');

  // ZIP de todos los QR.
  res = await get('/admin/impresion/qr.zip', { headers: { cookie: admin } });
  assert.match(res.headers.get('content-type'), /application\/zip/);
  const zipped = await bytes(res);
  assert.equal(zipped.readUInt32LE(0), 0x04034b50);
  for (const name of [`png/postea-qr-${a.slug}.png`, `svg/postea-qr-${a.slug}.svg`, `png/postea-qr-${b.slug}.png`, 'indice.csv']) assert.ok(zipped.includes(Buffer.from(name)), `ZIP incluye ${name}`);
  assert.ok(!zipped.includes(Buffer.from(`postea-qr-${c.slug}`)), 'el ZIP solo trae publicadas');
  assert.ok(!zipped.includes(Buffer.from('PROVISIONAL')), 'con URL confirmada no hay archivos provisionales');

  // Verificación del QR por coordinación.
  const coordPage = await (await get('/coordinacion', { headers: { cookie: coord } })).text();
  assert.match(coordPage, new RegExp(`href="${RENDER_URL}/f/${a.slug}\\?src=qr"`)); assert.match(coordPage, /sin verificar/);
  const token = csrfOf(coordPage);
  res = await get(`/coordinacion/investigaciones/${a.id}/verificar-qr`, { method: 'POST', headers: { cookie: coord }, body: new URLSearchParams({ _csrf: token }) });
  assert.equal(res.headers.get('location'), '/coordinacion?resultado=qr-verificado');
  assert.ok((await pool.query('SELECT qr_verificado_at FROM investigaciones WHERE id=$1', [a.id])).rows[0].qr_verificado_at);
  assert.match(await (await get('/coordinacion?resultado=qr-verificado', { headers: { cookie: coord } })).text(), /QR marcado como verificado/);
  res = await get(`/coordinacion/investigaciones/${c.id}/verificar-qr`, { method: 'POST', headers: { cookie: coord }, body: new URLSearchParams({ _csrf: token }) });
  assert.equal(res.status, 409, 'solo publicadas');
  const otherToken = csrfOf(await (await get('/coordinacion', { headers: { cookie: otherCoord } })).text());
  res = await get(`/coordinacion/investigaciones/${b.id}/verificar-qr`, { method: 'POST', headers: { cookie: otherCoord }, body: new URLSearchParams({ _csrf: otherToken }) });
  assert.equal(res.status, 404, 'otro programa no');
  await get(`/coordinacion/investigaciones/${a.id}/verificar-qr`, { method: 'POST', headers: { cookie: coord }, body: new URLSearchParams({ _csrf: token, accion: 'desmarcar' }) });
  assert.equal((await pool.query('SELECT qr_verificado_at FROM investigaciones WHERE id=$1', [a.id])).rows[0].qr_verificado_at, null);
  console.log('Fase 8 OK: QR PNG 1200 px y SVG decodificables, URL al vuelo, marca provisional, lectura simulada a 1 m, slugs cortos, pieza 50×70, permisos, lote, ZIP y verificación de QR.');
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  process.env.BASE_URL = originalBaseUrl;
  try {
    const ids = Object.values(users).map(u => u.id);
    for (const row of savedConfig) await pool.query('UPDATE configuracion SET valor=$2 WHERE clave=$1', [row.clave, JSON.stringify(row.valor)]);
    await pool.query('DELETE FROM investigaciones WHERE id=ANY($1::bigint[])', [items.map(i => i.id)]);
    await pool.query("DELETE FROM sesiones WHERE sess->>'userId'=ANY($1::text[])", [ids.map(String)]);
    await pool.query('DELETE FROM usuarios WHERE id=ANY($1::bigint[])', [ids]);
    await pool.query('DELETE FROM programas WHERE id=ANY($1::bigint[])', [[program, otherProgram].filter(Boolean)]);
  } finally { await new Promise(resolve => server.close(resolve)); await pool.end(); }
});
