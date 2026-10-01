const crypto = require('node:crypto');
const express = require('express');
const { z } = require('zod');
const { pool } = require('./db');
const { requireRole, csrfToken } = require('./account');
const { loadConfig, parseDate, TZ } = require('./config');
const { toCsv, parseCsv } = require('./csv');
const { zip } = require('./zip');
const router = express.Router();
const admin = requireRole('admin');

const FLOW_STATES = [['borrador', 'Borrador'], ['enviada', 'Enviada'], ['seleccionada', 'Seleccionada'], ['devuelta', 'Devuelta'], ['publicada', 'Publicada'], ['archivada', 'Archivada']];
const ROLES = ['visitante', 'autor', 'coordinador', 'admin'];
const USER_STATES = ['activo', 'pendiente', 'bloqueado'];
const RESET_HOURS = 72;
const id = value => /^\d{1,18}$/.test(String(value)) ? String(value) : null;
const normalize = text => String(text).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

class AdminError extends Error {}
// Los errores de validación vuelven a la página con un aviso; los demás siguen al manejador general.
const handle = back => fn => async (req, res, next) => {
  try { await fn(req, res); } catch (error) {
    if (!(error instanceof AdminError)) return next(error);
    req.session.adminFlash = { tipo: 'error', texto: error.message };
    res.redirect(back);
  }
};
const done = (req, res, back, texto) => { req.session.adminFlash = { tipo: 'ok', texto }; res.redirect(back); };
function takeFlash(req) { const flash = req.session.adminFlash || null; delete req.session.adminFlash; return flash; }
// Guardar antes de responder: así el aviso consumido no reaparece ni pisa el de la siguiente acción.
const render = (req, res, view, data) => {
  const locals = { csrf: csrfToken(req), flash: takeFlash(req), ...data };
  req.session.save(error => error ? res.status(500).render('error', { title: 'Ocurrió un problema' }) : res.render(view, locals));
};

// ---------- Tablero ----------
router.get('/admin', admin, async (req, res) => {
  const q = sql => pool.query(sql).then(r => r.rows);
  const [flow, programs, territories, users, scans, totals] = await Promise.all([
    q(`SELECT estado_flujo AS estado, count(*)::int AS n FROM investigaciones GROUP BY 1`),
    q(`SELECT p.id,p.nombre,p.cupo,p.activo,f.nombre AS facultad,
        count(*) FILTER (WHERE i.estado_flujo IN ('seleccionada','publicada'))::int AS ocupados,
        count(*) FILTER (WHERE i.estado_flujo='publicada')::int AS publicadas,
        count(*) FILTER (WHERE i.estado_flujo='enviada')::int AS enviadas,
        count(*) FILTER (WHERE i.estado_flujo IN ('borrador','devuelta'))::int AS en_edicion
      FROM programas p JOIN facultades f ON f.id=p.facultad_id LEFT JOIN investigaciones i ON i.programa_id=p.id
      WHERE p.activo GROUP BY p.id,f.nombre ORDER BY (count(*) FILTER (WHERE i.estado_flujo='publicada'))::float/p.cupo, p.nombre`),
    q(`SELECT t.id,t.nombre,count(i.id)::int AS n FROM territorios t LEFT JOIN investigaciones i ON i.territorio_id=t.id AND i.estado_flujo='publicada'
      GROUP BY t.id ORDER BY t.orden,t.nombre`),
    q(`SELECT rol,count(*)::int AS n FROM usuarios GROUP BY 1`),
    q(`SELECT to_char(d,'YYYY-MM-DD') AS dia,
        count(v.id) FILTER (WHERE v.origen='qr')::int AS qr, count(v.id) FILTER (WHERE v.origen='web')::int AS web
      FROM generate_series((now() AT TIME ZONE '${TZ}')::date - 13,(now() AT TIME ZONE '${TZ}')::date,interval '1 day') d
      LEFT JOIN visitas v ON (v.created_at AT TIME ZONE '${TZ}')::date=d::date GROUP BY d ORDER BY d`),
    q(`SELECT (SELECT count(*)::int FROM usuarios) AS usuarios,
        (SELECT count(*)::int FROM visitas WHERE origen='qr') AS escaneos,
        (SELECT count(*)::int FROM visitas) AS visitas,
        (SELECT coalesce(sum(monedas),0)::int FROM inversiones) AS monedas,
        (SELECT count(*)::int FROM inversiones) AS inversiones,
        (SELECT count(*)::int FROM comentarios WHERE estado='visible') AS comentarios,
        (SELECT count(*)::int FROM comentarios WHERE estado IN ('pendiente','reportado')) AS por_moderar`)
  ]);
  const flowMap = Object.fromEntries(flow.map(r => [r.estado, r.n]));
  const roleMap = Object.fromEntries(users.map(r => [r.rol, r.n]));
  const config = await loadConfig();
  render(req, res, 'admin-dashboard', { title: 'Tablero IMAGO',
    flow: FLOW_STATES.map(([key, label]) => ({ label, n: flowMap[key] || 0 })),
    programs, territories, scans, totals: totals[0], coinName: config.nombre_moneda || 'Imagos',
    roles: ROLES.map(rol => ({ rol, n: roleMap[rol] || 0 })),
    projected: programs.reduce((n, p) => n + p.cupo, 0) });
});

// ---------- Programas ----------
const programSchema = z.object({
  nombre: z.string().trim().min(3, 'El nombre del programa debe tener al menos 3 caracteres.').max(160),
  facultad_id: z.string().regex(/^\d+$/, 'Elige una facultad.'),
  cupo: z.coerce.number().int().min(1, 'El cupo debe ser de al menos 1.').max(100, 'El cupo máximo es 100.'),
  es_especializacion: z.boolean(), activo: z.boolean()
});
const programFrom = body => programSchema.safeParse({ ...body, es_especializacion: body.es_especializacion === 'on', activo: body.activo === 'on' });

router.get('/admin/programas', admin, async (req, res) => {
  const [programs, faculties] = await Promise.all([
    pool.query(`SELECT p.*,f.nombre AS facultad,
        (SELECT count(*)::int FROM investigaciones i WHERE i.programa_id=p.id AND i.estado_flujo IN ('seleccionada','publicada')) AS ocupados,
        (SELECT count(*)::int FROM investigaciones i WHERE i.programa_id=p.id AND i.estado_flujo<>'archivada') AS registradas,
        (SELECT count(*)::int FROM investigaciones i WHERE i.programa_id=p.id) AS fichas
      FROM programas p JOIN facultades f ON f.id=p.facultad_id ORDER BY f.orden,p.nombre`),
    pool.query('SELECT id,nombre FROM facultades ORDER BY orden,nombre')
  ]);
  render(req, res, 'admin-programs', { title: 'Programas · IMAGO', programs: programs.rows, faculties: faculties.rows });
});

router.post('/admin/programas', admin, handle('/admin/programas')(async (req, res) => {
  const parsed = programFrom(req.body);
  if (!parsed.success) throw new AdminError(parsed.error.issues[0].message);
  const result = await pool.query(`INSERT INTO programas(nombre,facultad_id,cupo,es_especializacion,activo) VALUES($1,$2,$3,$4,true)
    ON CONFLICT (nombre) DO NOTHING`, [parsed.data.nombre, parsed.data.facultad_id, parsed.data.cupo, parsed.data.es_especializacion]);
  if (!result.rowCount) throw new AdminError('Ya existe un programa con ese nombre.');
  done(req, res, '/admin/programas', `Programa «${parsed.data.nombre}» creado.`);
}));

router.post('/admin/programas/:id', admin, handle('/admin/programas')(async (req, res) => {
  const parsed = programFrom(req.body);
  if (!id(req.params.id) || !parsed.success) throw new AdminError(parsed.success ? 'Programa no válido.' : parsed.error.issues[0].message);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // El mismo bloqueo que usan la creación y la selección de fichas: el cupo no puede quedar por debajo de lo ya registrado.
    const program = (await client.query('SELECT id FROM programas WHERE id=$1 FOR UPDATE', [req.params.id])).rows[0];
    if (!program) throw new AdminError('No encontramos ese programa.');
    const used = (await client.query(`SELECT count(*)::int AS n FROM investigaciones WHERE programa_id=$1 AND estado_flujo<>'archivada'`, [program.id])).rows[0].n;
    if (parsed.data.cupo < used) throw new AdminError(`El programa ya tiene ${used} proyectos registrados; el cupo no puede ser menor. Archiva alguno si necesitas reducirlo.`);
    if ((await client.query('SELECT 1 FROM programas WHERE lower(nombre)=lower($1) AND id<>$2', [parsed.data.nombre, program.id])).rowCount) throw new AdminError('Ya existe otro programa con ese nombre.');
    await client.query('UPDATE programas SET nombre=$1,facultad_id=$2,cupo=$3,es_especializacion=$4,activo=$5 WHERE id=$6',
      [parsed.data.nombre, parsed.data.facultad_id, parsed.data.cupo, parsed.data.es_especializacion, parsed.data.activo, program.id]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  done(req, res, '/admin/programas', 'Programa actualizado.');
}));

const truthy = value => ['si', 'sí', 'true', '1', 'x', 'verdadero', 'yes'].includes(normalize(value));
const falsy = value => ['', 'no', 'false', '0', 'falso'].includes(normalize(value));

// Importación CSV `nombre,facultad,es_especializacion`. Todo o nada: si una línea falla no se importa ninguna.
router.post('/admin/programas-importar', admin, handle('/admin/programas')(async (req, res) => {
  const rows = parseCsv(String(req.body.csv || ''));
  if (!rows.length) throw new AdminError('Pega o selecciona un archivo CSV con programas.');
  if (normalize(rows[0][0]) === 'nombre') rows.shift();
  if (!rows.length || rows.length > 300) throw new AdminError('El CSV debe tener entre 1 y 300 programas.');
  const faculties = (await pool.query('SELECT id,nombre FROM facultades')).rows;
  const errors = [], parsed = [];
  rows.forEach(([nombre = '', facultad = '', especial = ''], index) => {
    const line = index + 2;
    const faculty = faculties.find(f => normalize(f.nombre) === normalize(facultad)) ||
      faculties.find(f => normalize(facultad).length >= 4 && normalize(f.nombre).includes(normalize(facultad)));
    if (nombre.length < 3 || nombre.length > 160) errors.push(`Línea ${line}: nombre de programa no válido.`);
    else if (!faculty) errors.push(`Línea ${line}: no reconocemos la facultad «${facultad}».`);
    else if (!truthy(especial) && !falsy(especial)) errors.push(`Línea ${line}: es_especializacion debe ser sí o no.`);
    else parsed.push({ nombre, facultad_id: faculty.id, especial: truthy(especial) });
  });
  const names = parsed.map(p => normalize(p.nombre));
  names.forEach((n, i) => { if (names.indexOf(n) !== i) errors.push(`El programa «${parsed[i].nombre}» está repetido en el archivo.`); });
  if (errors.length) throw new AdminError(`No se importó ningún programa. ${errors.slice(0, 5).join(' ')}${errors.length > 5 ? ` (y ${errors.length - 5} errores más)` : ''}`);
  const client = await pool.connect();
  let created = 0, updated = 0;
  try {
    await client.query('BEGIN');
    for (const p of parsed) {
      const existing = (await client.query('SELECT id FROM programas WHERE lower(nombre)=lower($1)', [p.nombre])).rows[0];
      if (existing) { await client.query('UPDATE programas SET facultad_id=$1,es_especializacion=$2 WHERE id=$3', [p.facultad_id, p.especial, existing.id]); updated++; }
      else { await client.query('INSERT INTO programas(nombre,facultad_id,es_especializacion) VALUES($1,$2,$3)', [p.nombre, p.facultad_id, p.especial]); created++; }
    }
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  done(req, res, '/admin/programas', `Importación lista: ${created} programas nuevos y ${updated} actualizados.`);
}));

// ---------- Territorios ----------
const slugify = text => normalize(text).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
const territorySchema = z.object({
  nombre: z.string().trim().min(3, 'El nombre debe tener al menos 3 caracteres.').max(80),
  color_hex: z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'El color debe tener formato #RRGGBB.'),
  icono: z.string().trim().max(40).optional().default(''),
  orden: z.coerce.number().int().min(0).max(999)
});

router.get('/admin/territorios', admin, async (req, res) => {
  const territories = (await pool.query(`SELECT t.*,(SELECT count(*)::int FROM investigaciones i WHERE i.territorio_id=t.id) AS usos
    FROM territorios t ORDER BY t.orden,t.nombre`)).rows;
  render(req, res, 'admin-territories', { title: 'Territorios · IMAGO', territories });
});

router.post('/admin/territorios', admin, handle('/admin/territorios')(async (req, res) => {
  const parsed = territorySchema.safeParse(req.body);
  if (!parsed.success) throw new AdminError(parsed.error.issues[0].message);
  const slug = slugify(parsed.data.nombre);
  const result = await pool.query(`INSERT INTO territorios(nombre,slug,color_hex,icono,orden) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
    [parsed.data.nombre, slug, parsed.data.color_hex.toUpperCase(), parsed.data.icono || null, parsed.data.orden]);
  if (!result.rowCount) throw new AdminError('Ya existe un territorio con ese nombre.');
  done(req, res, '/admin/territorios', `Territorio «${parsed.data.nombre}» creado.`);
}));

router.post('/admin/territorios/:id', admin, handle('/admin/territorios')(async (req, res) => {
  if (!id(req.params.id)) throw new AdminError('Territorio no válido.');
  if (req.body.accion === 'eliminar') {
    const result = await pool.query('DELETE FROM territorios t WHERE id=$1 AND NOT EXISTS (SELECT 1 FROM investigaciones i WHERE i.territorio_id=t.id)', [req.params.id]);
    if (!result.rowCount) throw new AdminError('No se puede eliminar un territorio con investigaciones asignadas. Reasígnalas primero.');
    return done(req, res, '/admin/territorios', 'Territorio eliminado.');
  }
  const parsed = territorySchema.safeParse(req.body);
  if (!parsed.success) throw new AdminError(parsed.error.issues[0].message);
  if ((await pool.query('SELECT 1 FROM territorios WHERE (lower(nombre)=lower($1) OR slug=$2) AND id<>$3', [parsed.data.nombre, slugify(parsed.data.nombre), req.params.id])).rowCount) {
    throw new AdminError('Ya existe otro territorio con ese nombre.');
  }
  await pool.query('UPDATE territorios SET nombre=$1,slug=$2,color_hex=$3,icono=$4,orden=$5 WHERE id=$6',
    [parsed.data.nombre, slugify(parsed.data.nombre), parsed.data.color_hex.toUpperCase(), parsed.data.icono || null, parsed.data.orden, req.params.id]);
  done(req, res, '/admin/territorios', 'Territorio actualizado.');
}));

// ---------- Usuarios ----------
router.get('/admin/usuarios', admin, async (req, res) => {
  const filters = { q: String(req.query.q || '').trim().slice(0, 100), rol: ROLES.includes(req.query.rol) ? req.query.rol : '',
    estado: USER_STATES.includes(req.query.estado) ? req.query.estado : '' };
  const page = Math.max(1, Math.min(1000, Number.parseInt(req.query.pagina, 10) || 1));
  const values = [], where = ['true'];
  if (filters.q) { values.push(`%${filters.q.toLowerCase()}%`); where.push(`(lower(u.nombre) LIKE $${values.length} OR u.email LIKE $${values.length})`); }
  if (filters.rol) { values.push(filters.rol); where.push(`u.rol=$${values.length}`); }
  if (filters.estado) { values.push(filters.estado); where.push(`u.estado=$${values.length}`); }
  const [users, count, programs] = await Promise.all([
    pool.query(`SELECT u.id,u.nombre,u.email,u.rol,u.estado,u.tipo_persona,u.programa_id,u.created_at,u.last_login_at,p.nombre AS programa,
        coalesce((SELECT array_agg(programa_id::text) FROM coordinadores_programa cp WHERE cp.usuario_id=u.id),'{}') AS coordina
      FROM usuarios u LEFT JOIN programas p ON p.id=u.programa_id WHERE ${where.join(' AND ')}
      ORDER BY u.created_at DESC LIMIT 50 OFFSET ${(page - 1) * 50}`, values),
    pool.query(`SELECT count(*)::int AS n FROM usuarios u WHERE ${where.join(' AND ')}`, values),
    pool.query('SELECT id,nombre FROM programas ORDER BY nombre')
  ]);
  const resetLink = req.session.resetLink || null;
  delete req.session.resetLink;
  render(req, res, 'admin-users', { title: 'Usuarios · IMAGO', users: users.rows, total: count.rows[0].n, page, filters,
    programs: programs.rows, roles: ROLES, states: USER_STATES, resetLink, back: req.originalUrl });
});

const safeBack = value => typeof value === 'string' && /^\/admin\/usuarios(\?[\w=&%.+-]*)?$/.test(value) ? value : '/admin/usuarios';

router.post('/admin/usuarios/:id', admin, (req, res, next) => handle(safeBack(req.body.back))(async () => {
  const back = safeBack(req.body.back);
  if (!id(req.params.id)) throw new AdminError('Usuario no válido.');
  const rol = ROLES.includes(req.body.rol) ? req.body.rol : null;
  const estado = USER_STATES.includes(req.body.estado) ? req.body.estado : null;
  const programId = req.body.programa_id ? id(req.body.programa_id) : null;
  const coordinates = [].concat(req.body.coordina || []).map(id).filter(Boolean);
  if (!rol || !estado) throw new AdminError('Elige un rol y un estado válidos.');
  if (String(req.params.id) === String(req.user.id) && (rol !== 'admin' || estado !== 'activo')) {
    throw new AdminError('No puedes quitarte el rol de admin ni bloquear tu propia cuenta.');
  }
  if (rol === 'autor' && !programId) throw new AdminError('Un autor necesita un programa.');
  if (rol === 'coordinador' && !coordinates.length) throw new AdminError('Asigna al menos un programa al coordinador.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const user = (await client.query('SELECT id,email FROM usuarios WHERE id=$1 FOR UPDATE', [req.params.id])).rows[0];
    if (!user) throw new AdminError('No encontramos ese usuario.');
    await client.query('UPDATE usuarios SET rol=$1,estado=$2,programa_id=$3 WHERE id=$4', [rol, estado, programId, user.id]);
    await client.query('DELETE FROM coordinadores_programa WHERE usuario_id=$1', [user.id]);
    if (rol === 'coordinador') {
      await client.query('INSERT INTO coordinadores_programa(usuario_id,programa_id) SELECT $1,unnest($2::bigint[]) ON CONFLICT DO NOTHING', [user.id, coordinates]);
    }
    // Una cuenta bloqueada pierde sus sesiones abiertas de inmediato.
    if (estado === 'bloqueado') await client.query("DELETE FROM sesiones WHERE sess->>'userId'=$1", [String(user.id)]);
    await client.query('COMMIT');
    done(req, res, back, `Cuenta de ${user.email} actualizada.`);
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
})(req, res, next));

router.post('/admin/usuarios/:id/restablecer', admin, handle('/admin/usuarios')(async (req, res) => {
  if (!id(req.params.id)) throw new AdminError('Usuario no válido.');
  const user = (await pool.query('SELECT id,email FROM usuarios WHERE id=$1', [req.params.id])).rows[0];
  if (!user) throw new AdminError('No encontramos ese usuario.');
  const token = crypto.randomBytes(32).toString('base64url');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Solo el último enlace generado sirve.
    await client.query('DELETE FROM tokens_reset WHERE usuario_id=$1', [user.id]);
    await client.query(`INSERT INTO tokens_reset(token_hash,usuario_id,expira_at) VALUES($1,$2,now()+interval '${RESET_HOURS} hours')`,
      [crypto.createHash('sha256').update(token).digest('hex'), user.id]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  // El enlace se muestra una sola vez; en la base solo queda su hash.
  req.session.resetLink = { email: user.email, url: `${(process.env.BASE_URL || '').replace(/\/$/, '')}/restablecer/${token}`, horas: RESET_HOURS };
  res.redirect(safeBack(req.body.back));
}));

// ---------- Configuración ----------
const bogotaInput = value => {
  const date = parseDate(value);
  if (!date) return '';
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
};
const DATE_KEYS = [['fecha_apertura', 'Apertura de convocatoria'], ['fecha_cierre', 'Cierre de convocatoria'],
  ['fecha_exhibicion_inicio', 'Inicio de la exhibición'], ['fecha_exhibicion_fin', 'Fin de la exhibición']];
const FLAGS = [['inversion_activa', 'Inversión activa', 'Permite invertir durante la exhibición.'],
  ['comentarios_activos', 'Comentarios activos', 'Permite comentar durante la exhibición.'],
  ['moderacion_previa', 'Moderación previa', 'Los comentarios esperan aprobación de IMAGO antes de publicarse.'],
  ['mostrar_ranking_publico', 'Ranking público', 'Muestra /ranking y el ranking en /pantalla.']];
const baseUrl = () => (process.env.BASE_URL || '').replace(/\/$/, '');
const provisionalUrl = () => !baseUrl() || /localhost|127\.0\.0\.1/.test(baseUrl());

router.get('/admin/configuracion', admin, async (req, res) => {
  const config = await loadConfig();
  render(req, res, 'admin-config', { title: 'Configuración · IMAGO', config, dateKeys: DATE_KEYS, flags: FLAGS,
    dates: Object.fromEntries(DATE_KEYS.map(([key]) => [key, bogotaInput(config[key])])),
    baseUrl: baseUrl(), provisional: provisionalUrl() });
});

router.post('/admin/configuracion', admin, handle('/admin/configuracion')(async (req, res) => {
  const values = {};
  for (const [key, label] of DATE_KEYS) {
    const raw = String(req.body[key] || '');
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(raw) || !parseDate(`${raw}:00-05:00`)) throw new AdminError(`Revisa la fecha «${label}».`);
    values[key] = `${raw}:00-05:00`;
  }
  const at = key => parseDate(values[key]).getTime();
  if (at('fecha_apertura') >= at('fecha_cierre')) throw new AdminError('El cierre de convocatoria debe ser posterior a la apertura.');
  if (at('fecha_exhibicion_inicio') >= at('fecha_exhibicion_fin')) throw new AdminError('El fin de la exhibición debe ser posterior al inicio.');
  const coins = Number(req.body.saldo_inicial_monedas);
  if (!Number.isInteger(coins) || coins < 1 || coins > 100000) throw new AdminError('El saldo inicial debe ser un número entero entre 1 y 100000.');
  const name = String(req.body.nombre_moneda || '').trim();
  if (name.length < 2 || name.length > 30) throw new AdminError('El nombre de la moneda debe tener entre 2 y 30 caracteres.');
  Object.assign(values, { saldo_inicial_monedas: coins, nombre_moneda: name });
  for (const [key] of FLAGS) values[key] = req.body[key] === 'on';
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const [key, value] of Object.entries(values)) {
      await client.query('INSERT INTO configuracion(clave,valor) VALUES($1,$2::jsonb) ON CONFLICT (clave) DO UPDATE SET valor=EXCLUDED.valor', [key, JSON.stringify(value)]);
    }
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  done(req, res, '/admin/configuracion', 'Configuración guardada.');
}));

router.post('/admin/configuracion/url-qr', admin, handle('/admin/configuracion')(async (req, res) => {
  const confirm = req.body.accion === 'confirmar';
  if (confirm && provisionalUrl()) throw new AdminError('BASE_URL todavía apunta a localhost o está vacía. Configura la URL definitiva de Render antes de confirmarla.');
  if (confirm && req.body.entiendo !== 'on') throw new AdminError('Marca la casilla para confirmar que la URL y los slugs no cambiarán después de imprimir.');
  await pool.query(`INSERT INTO configuracion(clave,valor) VALUES('url_qr_confirmada',$1::jsonb) ON CONFLICT (clave) DO UPDATE SET valor=EXCLUDED.valor`, [JSON.stringify(confirm)]);
  done(req, res, '/admin/configuracion', confirm ? 'URL de los QR confirmada. Ya puedes imprimir las piezas.' : 'La URL de los QR volvió a quedar como provisional.');
}));

// ---------- Exportaciones ----------
const EXPORTS = {
  investigaciones: `SELECT i.id,i.slug,i.titulo,i.subtitulo,i.pregunta_gancho,i.estado_flujo,i.estado_investigacion,i.tipo,
      p.nombre AS programa,f.nombre AS facultad,t.nombre AS territorio,u.nombre AS autor,u.email AS autor_email,
      (SELECT string_agg(nombre_completo,' | ' ORDER BY orden,id) FROM investigadores WHERE investigacion_id=i.id) AS investigadores,
      i.descripcion,i.objetivo,i.metodologia,i.resultados,i.imagen_credito,i.sharepoint_url,i.observaciones_revision,
      (SELECT coalesce(sum(monedas),0)::int FROM inversiones WHERE investigacion_id=i.id) AS monedas,
      (SELECT count(*)::int FROM comentarios WHERE investigacion_id=i.id AND estado='visible') AS comentarios_visibles,
      (SELECT count(*)::int FROM visitas WHERE investigacion_id=i.id) AS visitas,
      (SELECT count(*)::int FROM visitas WHERE investigacion_id=i.id AND origen='qr') AS escaneos_qr,
      i.created_at,i.updated_at,i.publicada_at
    FROM investigaciones i JOIN programas p ON p.id=i.programa_id JOIN facultades f ON f.id=p.facultad_id
    LEFT JOIN territorios t ON t.id=i.territorio_id JOIN usuarios u ON u.id=i.autor_id ORDER BY i.id`,
  usuarios: `SELECT u.id,u.nombre,u.email,u.rol,u.estado,u.tipo_persona,p.nombre AS programa,u.acepta_datos_at,u.acepta_datos_version,
      u.created_at,u.last_login_at FROM usuarios u LEFT JOIN programas p ON p.id=u.programa_id ORDER BY u.id`,
  inversiones: `SELECT v.id,v.usuario_id,u.email,v.investigacion_id,i.slug,i.titulo,v.monedas,v.created_at
    FROM inversiones v JOIN usuarios u ON u.id=v.usuario_id JOIN investigaciones i ON i.id=v.investigacion_id ORDER BY v.id`,
  comentarios: `SELECT c.id,c.usuario_id,u.email,c.investigacion_id,i.slug,c.tipo,c.texto,c.estado,
      (SELECT count(*)::int FROM reportes_comentario r WHERE r.comentario_id=c.id) AS reportes,c.moderado_at,c.created_at
    FROM comentarios c JOIN usuarios u ON u.id=c.usuario_id JOIN investigaciones i ON i.id=c.investigacion_id ORDER BY c.id`,
  visitas: `SELECT v.id,v.investigacion_id,i.slug,v.usuario_id,v.origen,v.created_at FROM visitas v JOIN investigaciones i ON i.id=v.investigacion_id ORDER BY v.id`,
  programas: `SELECT p.id,p.nombre,f.nombre AS facultad,p.es_especializacion,p.cupo,p.activo FROM programas p JOIN facultades f ON f.id=p.facultad_id ORDER BY p.id`
};

// Respaldo completo: todas las tablas tal cual (sin contraseñas, sesiones ni tokens), con imágenes en base64.
const BACKUP_TABLES = ['facultades', 'programas', 'territorios', 'usuarios', 'coordinadores_programa', 'investigaciones', 'investigadores',
  'inversiones', 'comentarios', 'reportes_comentario', 'visitas', 'configuracion', 'schema_migrations'];
async function backupJson({ images = true } = {}) {
  const data = { generado_at: new Date().toISOString(), base_url: baseUrl(), tablas: {} };
  for (const table of BACKUP_TABLES) {
    const rows = (await pool.query(`SELECT * FROM ${table} ORDER BY 1`)).rows;
    data.tablas[table] = rows.map(row => {
      const copy = { ...row };
      delete copy.password_hash;
      if (table === 'investigaciones') copy.imagen = images && row.imagen ? row.imagen.toString('base64') : null;
      return copy;
    });
  }
  return JSON.stringify(data, null, 1);
}
const stamp = () => bogotaInput(new Date().toISOString()).replace(/[-:]/g, '').replace('T', '-');

router.get('/admin/exportar', admin, async (req, res) => {
  const counts = Object.fromEntries(await Promise.all(Object.keys(EXPORTS).map(async key =>
    [key, (await pool.query(`SELECT count(*)::int AS n FROM ${key}`)).rows[0].n])));
  render(req, res, 'admin-export', { title: 'Exportar datos · IMAGO', counts });
});

router.get('/admin/exportar/:archivo', admin, async (req, res) => {
  const file = req.params.archivo;
  res.set('Cache-Control', 'no-store');
  const csvMatch = file.match(/^(\w+)\.csv$/);
  if (csvMatch && EXPORTS[csvMatch[1]]) {
    const rows = (await pool.query(EXPORTS[csvMatch[1]])).rows;
    return res.attachment(`postea-${csvMatch[1]}-${stamp()}.csv`).type('text/csv; charset=utf-8').send(toCsv(rows));
  }
  if (file === 'respaldo.json') {
    return res.attachment(`postea-respaldo-${stamp()}.json`).type('application/json').send(await backupJson({ images: req.query.imagenes !== '0' }));
  }
  if (file === 'todo.zip') {
    const files = [];
    for (const [key, sql] of Object.entries(EXPORTS)) files.push({ name: `${key}.csv`, data: toCsv((await pool.query(sql)).rows) });
    files.push({ name: 'respaldo-completo.json', data: await backupJson() });
    return res.attachment(`postea-exportacion-${stamp()}.zip`).type('application/zip').send(zip(files));
  }
  res.status(404).render('not-found', { title: 'Página no encontrada' });
});

module.exports = router;
