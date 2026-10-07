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
const users = {}, items = [], territoryIds = [];
let savedConfig = [];
const programName = n => `DEMO f7 ${suffix} ${n}`;

const get = (path, options = {}) => fetch(base + path, { redirect: 'manual', ...options });
const csrfOf = html => html.match(/name="_csrf" value="([a-f0-9]+)"/)[1];
const flashOf = async (cookie, path) => (await (await get(path, { headers: { cookie } })).text());
async function login(email, secret = password) {
  const page = await get('/ingresar');
  const cookie = page.headers.get('set-cookie').split(';')[0];
  const res = await get('/ingresar', { method: 'POST', headers: { cookie }, body: new URLSearchParams({ _csrf: csrfOf(await page.text()), email, password: secret }) });
  return res.status === 302 ? res.headers.get('set-cookie').split(';')[0] : null;
}
let adminCookie, adminCsrf;
async function adminPost(path, fields) {
  const res = await get(path, { method: 'POST', headers: { cookie: adminCookie }, body: new URLSearchParams({ _csrf: adminCsrf, ...fields }) });
  assert.equal(res.status, 302, `${path} redirige`);
  return res.headers.get('location');
}
const programId = async name => (await pool.query('SELECT id,cupo,facultad_id,es_especializacion,activo FROM programas WHERE nombre=$1', [name])).rows[0];

async function main() {
  savedConfig = (await pool.query('SELECT clave,valor FROM configuracion')).rows;
  const hash = await bcrypt.hash(password, 10);
  for (const key of ['v1', 'v2']) {
    users[key] = (await pool.query(`INSERT INTO usuarios(nombre,email,password_hash,rol,estado,tipo_persona,acepta_datos_at,acepta_datos_version)
      VALUES($1,$2,$3,'visitante','activo','externo',now(),'prueba') RETURNING id,email`, [`=HYPERLINK("x") ${key}`, `f7-${key}-${suffix}@example.com`, hash])).rows[0];
  }
  adminCookie = await login(process.env.ADMIN_EMAIL, process.env.ADMIN_PASSWORD);
  assert.ok(adminCookie, 'ingreso admin');
  adminCsrf = csrfOf(await flashOf(adminCookie, '/admin'));
  const v1 = await login(users.v1.email);

  // Permisos.
  for (const path of ['/admin', '/admin/programas', '/admin/usuarios', '/admin/configuracion', '/admin/exportar', '/admin/exportar/todo.zip']) {
    assert.equal((await get(path, { headers: { cookie: v1 } })).status, 403, `${path} solo admin`);
    assert.equal((await get(path)).status, 302, `${path} pide ingreso`);
  }

  // Programas: crear, duplicado, importar CSV (todo o nada), cupo.
  const faculties = (await pool.query('SELECT id,nombre FROM facultades ORDER BY orden')).rows;
  await adminPost('/admin/programas', { nombre: programName('A'), facultad_id: faculties[0].id, cupo: '3' });
  assert.ok(await programId(programName('A')));
  await adminPost('/admin/programas', { nombre: programName('A'), facultad_id: faculties[0].id, cupo: '3' });
  assert.match(await flashOf(adminCookie, '/admin/programas'), /Ya existe un programa con ese nombre/);
  const bad = `nombre,facultad,es_especializacion\n${programName('B')},Facultad de Ingeniería,no\n${programName('C')},Facultad Inventada,no`;
  await adminPost('/admin/programas-importar', { csv: bad });
  assert.match(await flashOf(adminCookie, '/admin/programas'), /No se importó ningún programa.*Facultad Inventada/);
  assert.equal(await programId(programName('B')), undefined, 'todo o nada');
  const good = `﻿nombre;facultad;es_especializacion\r\n${programName('B')};escuela de negocios;no\r\n"${programName('C')}";FACULTAD DE CIENCIAS SOCIALES Y DE LA EDUCACION;sí\r\n${programName('A')};Escuela de Negocios;si\r\n`;
  await adminPost('/admin/programas-importar', { csv: good });
  assert.match(await flashOf(adminCookie, '/admin/programas'), /2 programas nuevos y 1 actualizados/);
  const b = await programId(programName('B')), c = await programId(programName('C')), a = await programId(programName('A'));
  assert.equal(String(b.facultad_id), String(faculties[1].id));
  assert.equal(c.es_especializacion, true); assert.equal(String(a.facultad_id), String(faculties[1].id), 'existente se actualiza');
  // CSV grande (más de 16 KB) sí se acepta en esta ruta.
  const big = ['nombre,facultad,es_especializacion', ...Array.from({ length: 250 }, (_, n) => `${programName(`big-${n}`)} ${'relleno'.repeat(6)},Facultad de Ingeniería,no`)].join('\n');
  assert.ok(Buffer.byteLength(big) > 16 * 1024);
  await adminPost('/admin/programas-importar', { csv: big });
  assert.match(await flashOf(adminCookie, '/admin/programas'), /250 programas nuevos/);
  // Cupo no puede quedar por debajo de lo ocupado.
  const territory = (await pool.query('SELECT id FROM territorios ORDER BY orden LIMIT 1')).rows[0];
  const image = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#2a1150' } }).webp().toBuffer();
  for (let n = 0; n < 2; n++) {
    items.push((await pool.query(`INSERT INTO investigaciones(slug,programa_id,territorio_id,autor_id,titulo,pregunta_gancho,descripcion,objetivo,metodologia,resultados,
      estado_investigacion,tipo,imagen,imagen_mime,estado_flujo,publicada_at) VALUES($1,$2,$3,$4,$5,$6,'D','O','M','R','terminada','investigacion',$7,'image/webp','publicada',now()) RETURNING id,slug`,
    [`f7-${suffix}-${n}`, a.id, territory.id, users.v2.id, `DEMO f7 ficha ${n}`, `¿Pregunta DEMO ${suffix} ${n}?`, image])).rows[0]);
  }
  await adminPost(`/admin/programas/${a.id}`, { nombre: programName('A'), facultad_id: faculties[1].id, cupo: '1', activo: 'on' });
  const cupoPage = await flashOf(adminCookie, '/admin/programas');
  assert.match(cupoPage, /ya tiene 2 proyectos registrados/);
  await adminPost(`/admin/programas/${a.id}`, { nombre: programName('A'), facultad_id: faculties[1].id, cupo: '4' });
  assert.deepEqual([(await programId(programName('A'))).cupo, (await programId(programName('A'))).activo], [4, false]);

  // Tablero.
  const dash = await flashOf(adminCookie, '/admin');
  assert.match(dash, /Posts publicados/); assert.match(dash, /quién falta/); assert.match(dash, new RegExp(programName('B')));
  assert.match(dash, /<rect class="bar-fill" width="[\d.]+%"/); assert.doesNotMatch(dash, /style="/, 'sin estilos en línea (CSP)');

  // Territorios.
  await adminPost('/admin/territorios', { nombre: `DEMO Territorio ${suffix}`, color_hex: '#123abc', icono: '', orden: '9' });
  const newTerritory = (await pool.query('SELECT id,slug,color_hex FROM territorios WHERE nombre=$1', [`DEMO Territorio ${suffix}`])).rows[0];
  territoryIds.push(newTerritory.id);
  assert.equal(newTerritory.color_hex, '#123ABC'); assert.equal(newTerritory.slug, `demo-territorio-${suffix}`);
  assert.ok((await (await get('/css/catalogos.css')).text()).includes(`.ter-${newTerritory.id}{--ter:#123ABC}`));
  await adminPost(`/admin/territorios/${territory.id}`, { accion: 'eliminar' });
  assert.match(await flashOf(adminCookie, '/admin/territorios'), /No se puede eliminar un territorio con investigaciones/);
  await adminPost(`/admin/territorios/${newTerritory.id}`, { accion: 'eliminar' });
  assert.equal((await pool.query('SELECT 1 FROM territorios WHERE id=$1', [newTerritory.id])).rowCount, 0);

  // Usuarios: coordinador con programas, bloqueo con cierre de sesión, protección propia.
  // Las casillas de programas llegan como varios campos `coordina`, igual que en el formulario real.
  const body = new URLSearchParams({ _csrf: adminCsrf, rol: 'coordinador', estado: 'activo', programa_id: '', back: '/admin/usuarios?q=f7' });
  body.append('coordina', b.id); body.append('coordina', c.id);
  let res = await get(`/admin/usuarios/${users.v1.id}`, { method: 'POST', headers: { cookie: adminCookie }, body });
  assert.equal(res.headers.get('location'), '/admin/usuarios?q=f7');
  assert.deepEqual((await pool.query('SELECT programa_id::text FROM coordinadores_programa WHERE usuario_id=$1 ORDER BY 1', [users.v1.id])).rows.map(r => r.programa_id).sort(), [String(b.id), String(c.id)].sort());
  assert.equal((await get('/coordinacion', { headers: { cookie: v1 } })).status, 200, 'el coordinador entra a su panel');
  await adminPost(`/admin/usuarios/${users.v1.id}`, { rol: 'autor', estado: 'activo', programa_id: '' });
  assert.match(await flashOf(adminCookie, '/admin/usuarios'), /Un autor necesita un programa/);
  await adminPost(`/admin/usuarios/${users.v1.id}`, { rol: 'visitante', estado: 'bloqueado' });
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM coordinadores_programa WHERE usuario_id=$1', [users.v1.id])).rows[0].n, 0);
  assert.equal((await get('/mi-cuenta', { headers: { cookie: v1 } })).status, 302, 'la sesión del bloqueado se cierra');
  assert.equal(await login(users.v1.email), null, 'un bloqueado no ingresa');
  const adminId = (await pool.query('SELECT id FROM usuarios WHERE email=$1', [process.env.ADMIN_EMAIL])).rows[0].id;
  await adminPost(`/admin/usuarios/${adminId}`, { rol: 'visitante', estado: 'activo' });
  const selfPage = await flashOf(adminCookie, '/admin/usuarios');
  assert.match(selfPage, /No puedes quitarte el rol de admin/);
  assert.equal((await pool.query('SELECT rol FROM usuarios WHERE id=$1', [adminId])).rows[0].rol, 'admin');
  const listed = await flashOf(adminCookie, `/admin/usuarios?q=${encodeURIComponent(`f7-v2-${suffix}`)}`);
  assert.match(listed, /<strong>1<\/strong> cuentas/);

  // Enlace de restablecimiento: se muestra una vez, sirve una vez y cierra sesiones.
  const v2 = await login(users.v2.email);
  await adminPost(`/admin/usuarios/${users.v2.id}/restablecer`, { back: '/admin/usuarios' });
  const withLink = await flashOf(adminCookie, '/admin/usuarios');
  const link = withLink.match(/value="[^"]*(\/restablecer\/[A-Za-z0-9_-]{43})"/)[1];
  assert.doesNotMatch(await flashOf(adminCookie, '/admin/usuarios'), /\/restablecer\//, 'el enlace no se vuelve a mostrar');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM tokens_reset WHERE usuario_id=$1', [users.v2.id])).rows[0].n, 1);
  assert.ok(!(await pool.query('SELECT token_hash FROM tokens_reset WHERE usuario_id=$1', [users.v2.id])).rows[0].token_hash.includes(link.split('/').pop()), 'solo se guarda el hash');
  const form = await get(link); assert.equal(form.status, 200);
  const formCookie = form.headers.get('set-cookie').split(';')[0]; const formCsrf = csrfOf(await form.text());
  const newPassword = 'NuevaClave-' + suffix;
  res = await get(link, { method: 'POST', headers: { cookie: formCookie }, body: new URLSearchParams({ _csrf: formCsrf, password: newPassword, password2: 'otra' }) });
  assert.equal(res.status, 400); assert.match(await res.text(), /no coinciden/);
  res = await get(link, { method: 'POST', headers: { cookie: formCookie }, body: new URLSearchParams({ _csrf: formCsrf, password: newPassword, password2: newPassword }) });
  assert.equal(res.headers.get('location'), '/ingresar?restablecida=1');
  assert.match(await (await get('/ingresar?restablecida=1')).text(), /Tu contraseña se actualizó/);
  assert.equal((await get('/mi-cuenta', { headers: { cookie: v2 } })).status, 302, 'sesiones anteriores cerradas');
  assert.equal(await login(users.v2.email), null, 'la contraseña anterior ya no sirve');
  assert.ok(await login(users.v2.email, newPassword), 'la nueva sí');
  assert.equal((await get(link)).status, 410, 'el enlace no se reutiliza');
  assert.equal((await get('/restablecer/corto')).status, 410);

  // Configuración.
  await adminPost('/admin/configuracion', { fecha_apertura: '2026-10-05T00:00', fecha_cierre: '2026-10-04T00:00', fecha_exhibicion_inicio: '2026-10-27T00:00',
    fecha_exhibicion_fin: '2026-10-30T23:59', saldo_inicial_monedas: '100', nombre_moneda: 'Imagos' });
  assert.match(await flashOf(adminCookie, '/admin/configuracion'), /El cierre de convocatoria debe ser posterior/);
  await adminPost('/admin/configuracion', { fecha_apertura: '2026-10-05T00:00', fecha_cierre: '2026-10-19T23:59', fecha_exhibicion_inicio: '2026-10-27T08:00',
    fecha_exhibicion_fin: '2026-10-30T23:59', saldo_inicial_monedas: '150', nombre_moneda: 'Chispas', inversion_activa: 'on', mostrar_ranking_publico: 'on' });
  const cfg = Object.fromEntries((await pool.query('SELECT clave,valor FROM configuracion')).rows.map(r => [r.clave, r.valor]));
  assert.equal(cfg.fecha_exhibicion_inicio, '2026-10-27T08:00:00-05:00'); assert.equal(cfg.saldo_inicial_monedas, 150);
  assert.equal(cfg.nombre_moneda, 'Chispas'); assert.equal(cfg.inversion_activa, true); assert.equal(cfg.comentarios_activos, false);
  assert.match(await flashOf(adminCookie, '/admin/configuracion'), /value="2026-10-27T08:00"/, 'se muestra en hora de Bogotá');
  if (/localhost|127\.0\.0\.1/.test(process.env.BASE_URL || 'localhost')) {
    await adminPost('/admin/configuracion/url-qr', { accion: 'confirmar', entiendo: 'on' });
    assert.match(await flashOf(adminCookie, '/admin/configuracion'), /BASE_URL todavía apunta a localhost/);
    assert.equal((await pool.query("SELECT valor FROM configuracion WHERE clave='url_qr_confirmada'")).rows[0].valor, false);
  }

  // Ranking y pantalla.
  await pool.query('INSERT INTO inversiones(usuario_id,investigacion_id,monedas) VALUES($1,$2,7),($1,$3,40)', [users.v1.id, items[0].id, items[1].id]);
  let ranking = await (await get('/ranking')).text();
  assert.ok(ranking.indexOf(items[1].slug) > -1 && ranking.indexOf(items[1].slug) < ranking.indexOf(items[0].slug), 'orden por monedas');
  assert.match(ranking, /Más Chispas invertidos/);
  await pool.query("UPDATE configuracion SET valor='false' WHERE clave='mostrar_ranking_publico'");
  ranking = await (await get('/ranking')).text();
  assert.match(ranking, /El ranking se publicará pronto/); assert.doesNotMatch(ranking, new RegExp(items[1].slug));
  assert.match(await flashOf(adminCookie, '/ranking'), /Vista previa de admin/);
  const screen = await get('/pantalla'); assert.equal(screen.status, 200);
  const screenHtml = await screen.text();
  assert.match(screenHtml, /<meta http-equiv="refresh" content="30">/); assert.match(screenHtml, /Últimos comentarios/);
  assert.doesNotMatch(screenHtml, /Ideas con más apoyo/, 'sin ranking si no es público');

  // Exportaciones.
  const csv = await get('/admin/exportar/usuarios.csv', { headers: { cookie: adminCookie } });
  assert.match(csv.headers.get('content-disposition'), /attachment; filename="postea-usuarios-/);
  const csvBytes = Buffer.from(await csv.arrayBuffer());
  assert.deepEqual([...csvBytes.subarray(0, 3)], [0xEF, 0xBB, 0xBF], 'BOM UTF-8 para Excel');
  const csvText = csvBytes.toString('utf8');
  assert.doesNotMatch(csvText, /password|\$2b\$/); assert.match(csvText, /"'=HYPERLINK\(""x""\) v1"/, 'fórmulas neutralizadas');
  for (const name of ['investigaciones', 'inversiones', 'comentarios', 'visitas', 'programas']) {
    // Se lee el archivo completo, como un navegador: una descarga a medias mantiene ocupada la exportación.
    const exported = await get(`/admin/exportar/${name}.csv`, { headers: { cookie: adminCookie } });
    assert.equal(exported.status, 200, `${name}.csv`); await exported.arrayBuffer();
  }
  const backup = JSON.parse(await (await get('/admin/exportar/respaldo.json', { headers: { cookie: adminCookie } })).text());
  assert.ok(backup.tablas.usuarios.every(u => !('password_hash' in u)));
  const exported = backup.tablas.investigaciones.find(i => i.slug === items[0].slug);
  assert.equal(Buffer.from(exported.imagen, 'base64').subarray(0, 4).toString(), 'RIFF', 'imagen WebP en base64');
  assert.equal(JSON.parse(await (await get('/admin/exportar/respaldo.json?imagenes=0', { headers: { cookie: adminCookie } })).text())
    .tablas.investigaciones.find(i => i.slug === items[0].slug).imagen, null);
  const zipped = Buffer.from(await (await get('/admin/exportar/todo.zip', { headers: { cookie: adminCookie } })).arrayBuffer());
  assert.equal(zipped.readUInt32LE(0), 0x04034b50, 'ZIP válido');
  for (const name of ['investigaciones.csv', 'usuarios.csv', 'inversiones.csv', 'comentarios.csv', 'visitas.csv', 'programas.csv', 'respaldo-completo.json']) {
    assert.ok(zipped.includes(Buffer.from(name)), `ZIP incluye ${name}`);
  }
  assert.equal((await get('/admin/exportar/secreto.csv', { headers: { cookie: adminCookie } })).status, 404);
  console.log('Fase 7 OK: permisos, tablero, programas e importación CSV, cupo, territorios, usuarios y coordinadores, bloqueo, restablecimiento, configuración, URL de QR, ranking, pantalla y exportaciones CSV/JSON/ZIP.');
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  try {
    const ids = Object.values(users).map(u => u.id);
    for (const row of savedConfig) await pool.query('UPDATE configuracion SET valor=$2 WHERE clave=$1', [row.clave, JSON.stringify(row.valor)]);
    await pool.query('DELETE FROM inversiones WHERE usuario_id=ANY($1::bigint[])', [ids]);
    await pool.query('DELETE FROM visitas WHERE investigacion_id=ANY($1::bigint[])', [items.map(i => i.id)]);
    await pool.query('DELETE FROM investigaciones WHERE id=ANY($1::bigint[])', [items.map(i => i.id)]);
    await pool.query("DELETE FROM sesiones WHERE sess->>'userId'=ANY($1::text[])", [ids.map(String)]);
    await pool.query('DELETE FROM usuarios WHERE id=ANY($1::bigint[])', [ids]);
    await pool.query('DELETE FROM programas WHERE nombre LIKE $1', [`DEMO f7 ${suffix}%`]);
    await pool.query('DELETE FROM territorios WHERE id=ANY($1::bigint[])', [territoryIds]);
  } finally { await new Promise(resolve => server.close(resolve)); await pool.end(); }
});
