const crypto = require('node:crypto');
const bcrypt = require('bcrypt');
const express = require('express');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const { z } = require('zod');
const { pool } = require('./db');
const { loadConfig, participation } = require('./config');
const { balance, coinName, COMMENT_TYPES } = require('./interaction');
const { clientIp } = require('./client-ip');

const router = express.Router();
const PRIVACY_VERSION = '2026-pruebas-01';
const PERSON_TYPES = ['estudiante', 'docente', 'investigador', 'semillero', 'proyecto de grado', 'pasante', 'administrativo', 'egresado', 'externo'];
// Frente al vidrio muchas personas comparten la IP de la wifi del campus: el registro tolera ráfagas
// y el ingreso cuenta solo intentos fallidos por IP + correo.
const registerLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 60, standardHeaders: 'draft-8', legacyHeaders: false,
  keyGenerator: req => ipKeyGenerator(clientIp(req)),
  message: 'Hubo muchos intentos de registro. Inténtalo más tarde.' });
const loginLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false,
  skipSuccessfulRequests: true, requestWasSuccessful: (_req, res) => res.statusCode < 400,
  keyGenerator: req => `${ipKeyGenerator(clientIp(req))}|${String(req.body?.email || '').trim().toLowerCase().slice(0, 254)}`,
  message: 'Hubo muchos intentos de ingreso con este correo. Inténtalo en 15 minutos.' });

const DUMMY_HASH = bcrypt.hashSync('postea-sin-cuenta', 12);

function safeNext(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || /[\\\x00-\x1f]/.test(value)) return '/mi-cuenta';
  try {
    const url = new URL(value, 'http://postea.local');
    return url.origin === 'http://postea.local' ? url.pathname + url.search + url.hash : '/mi-cuenta';
  } catch { return '/mi-cuenta'; }
}

function csrfToken(req) {
  if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  return req.session.csrfToken;
}

function verifyCsrf(req, res, next) {
  const expected = req.session.csrfToken;
  const received = req.body?._csrf;
  if (typeof expected !== 'string' || typeof received !== 'string' ||
      expected.length !== received.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(received))) {
    return res.status(403).render('error', { title: 'Formulario vencido', message: 'Actualiza la página y vuelve a intentarlo.' });
  }
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) return res.redirect(`/ingresar?next=${encodeURIComponent(safeNext(req.originalUrl))}`);
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return requireAuth(req, res, next);
    if (!roles.includes(req.user.rol) || req.user.estado !== 'activo') return res.status(403).render('error', {
      title: 'Acceso pendiente', message: 'Tu cuenta aún no tiene permiso para esta sección.'
    });
    next();
  };
}

async function loadUser(req, res, next) {
  res.locals.user = null;
  if (!req.session?.userId) return next();
  try {
    const result = await pool.query('SELECT id, nombre, email, rol, estado, programa_id FROM usuarios WHERE id = $1', [req.session.userId]);
    const user = result.rows[0];
    if (!user || user.estado === 'bloqueado') {
      delete req.session.userId;
      return next();
    }
    req.user = user;
    res.locals.user = user;
    res.locals.csrf = csrfToken(req);
    next();
  } catch (error) { next(error); }
}

async function programs() {
  return (await pool.query(`SELECT p.id, p.nombre, f.nombre AS facultad
    FROM programas p JOIN facultades f ON f.id = p.facultad_id
    WHERE p.activo = true ORDER BY f.orden, p.nombre`)).rows;
}

function domainsAllowed(email, wantsToPost) {
  const domains = (process.env.ALLOWED_EMAIL_DOMAINS || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
  if (!domains.length || (!wantsToPost && process.env.VISITOR_DOMAIN_RESTRICTED !== 'true')) return true;
  return domains.includes(email.split('@')[1]);
}

const registerSchema = z.object({
  nombre: z.string().trim().min(2).max(120),
  email: z.email().max(254).transform(x => x.trim().toLowerCase()),
  password: z.string().min(8).refine(x => Buffer.byteLength(x, 'utf8') <= 72),
  tipo_persona: z.enum(PERSON_TYPES),
  programa_id: z.union([z.literal(''), z.coerce.number().int().positive()]),
  acepta_datos: z.literal('si')
});

function formError(issue) {
  const field = issue?.path?.[0];
  const messages = {
    nombre: 'Escribe tu nombre completo (2 a 120 caracteres).',
    email: 'Escribe un correo válido.',
    password: 'Usa una contraseña de 8 a 72 bytes.',
    tipo_persona: 'Selecciona tu rol.',
    programa_id: 'Selecciona un programa válido.',
    acepta_datos: 'Debes aceptar el tratamiento de datos para continuar.'
  };
  return messages[field] || 'Revisa los datos del formulario.';
}

function regenerate(req) {
  return new Promise((resolve, reject) => req.session.regenerate(error => error ? reject(error) : resolve()));
}

router.get('/registro', async (req, res) => {
  if (req.user) return res.redirect('/mi-cuenta');
  res.render('register', { title: 'Crea tu cuenta', csrf: csrfToken(req), nextUrl: safeNext(req.query.next),
    options: await programs(), personTypes: PERSON_TYPES, error: null, values: {} });
});

router.post('/registro', registerLimit, async (req, res) => {
  const nextUrl = safeNext(req.body.next);
  const values = {
    nombre: req.body.nombre || '', email: req.body.email || '', tipo_persona: req.body.tipo_persona || '',
    programa_id: req.body.programa_id || '', wantsToPost: req.body.wants_to_post === 'si',
    acepta_datos: req.body.acepta_datos === 'si'
  };
  const options = await programs();
  const renderError = (error) => res.status(400).render('register', {
    title: 'Crea tu cuenta', csrf: csrfToken(req), nextUrl, options, personTypes: PERSON_TYPES, error, values
  });
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) return renderError(formError(parsed.error.issues[0]));
  const data = parsed.data;
  if (values.wantsToPost && !data.programa_id) return renderError('Para postear, selecciona tu programa.');
  if (data.programa_id && !options.some(x => x.id === String(data.programa_id))) return renderError('Selecciona un programa activo.');
  if (!domainsAllowed(data.email, values.wantsToPost)) return renderError('Ese correo no pertenece a un dominio permitido para este tipo de cuenta.');
  const hash = await bcrypt.hash(data.password, 12);
  try {
    const result = await pool.query(`INSERT INTO usuarios
      (nombre, email, password_hash, rol, estado, tipo_persona, programa_id, acepta_datos_at, acepta_datos_version)
      VALUES ($1, $2, $3, $4, $5, $6, $7, now(), $8) RETURNING id`,
      // Autores y visitantes quedan activos al registrarse: el autor crea fichas de inmediato. Lo que se revisa
      // (coordinación e IMAGO) son las fichas antes de publicarse, no la cuenta.
      [data.nombre, data.email, hash, values.wantsToPost ? 'autor' : 'visitante', 'activo', data.tipo_persona,
        data.programa_id || null, PRIVACY_VERSION]);
    await regenerate(req);
    req.session.userId = result.rows[0].id;
    res.redirect(nextUrl);
  } catch (error) {
    if (error.code === '23505') return renderError('Ese correo ya tiene una cuenta. Ingresa con tu contraseña.');
    throw error;
  }
});

router.get('/ingresar', (req, res) => {
  if (req.user) return res.redirect('/mi-cuenta');
  res.render('login', { title: 'Ingresa a POSTEA', csrf: csrfToken(req), nextUrl: safeNext(req.query.next), error: null, email: '',
    notice: req.query.restablecida === '1' ? 'Tu contraseña se actualizó. Ingresa con la nueva.' : null });
});

router.post('/ingresar', loginLimit, async (req, res) => {
  const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const nextUrl = safeNext(req.body.next);
  const invalid = () => res.status(400).render('login', { title: 'Ingresa a POSTEA', csrf: csrfToken(req), nextUrl,
    error: 'Correo o contraseña incorrectos, o cuenta bloqueada.', email });
  if (!email || !password) return invalid();
  const result = await pool.query('SELECT id, password_hash, estado FROM usuarios WHERE email = $1', [email]);
  const user = result.rows[0];
  // Con correo inexistente también se compara contra un hash, para que el tiempo de respuesta no delate qué correos existen.
  const matches = await bcrypt.compare(password.slice(0, 128), user ? user.password_hash : DUMMY_HASH);
  if (!user || !matches || user.estado === 'bloqueado') return invalid();
  await pool.query('UPDATE usuarios SET last_login_at = now() WHERE id = $1', [user.id]);
  await regenerate(req);
  req.session.userId = user.id;
  res.redirect(nextUrl);
});

// Salir siempre termina en la página inicial, aunque la sesión ya hubiera vencido en otra pestaña.
router.post('/salir', (req, res, next) => {
  if (!req.session) return res.redirect('/?salida=1');
  req.session.destroy(error => {
    if (error) return next(error);
    res.clearCookie('postea.sid', { path: '/', httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' });
    res.redirect('/?salida=1');
  });
});
router.get('/salir', (req, res) => res.redirect(req.user ? '/mi-cuenta' : '/'));

router.get('/mi-cuenta', requireAuth, async (req, res) => {
  const config = await loadConfig();
  const [investments, comments, wallet] = await Promise.all([
    pool.query(`SELECT v.monedas,v.created_at,i.titulo,i.slug,i.estado_flujo FROM inversiones v JOIN investigaciones i ON i.id=v.investigacion_id
      WHERE v.usuario_id=$1 ORDER BY v.created_at DESC`, [req.user.id]),
    pool.query(`SELECT c.tipo,c.texto,c.estado,c.created_at,i.titulo,i.slug,i.estado_flujo FROM comentarios c JOIN investigaciones i ON i.id=c.investigacion_id
      WHERE c.usuario_id=$1 ORDER BY c.created_at DESC`, [req.user.id]),
    balance(pool, req.user.id, config)
  ]);
  res.render('account', { title: 'Mi cuenta', csrf: csrfToken(req), wallet, coinName: coinName(config),
    investments: investments.rows, comments: comments.rows, commentTypes: COMMENT_TYPES,
    exhibition: participation(config, 'inversion_activa', 'La inversión') });
});

// Restablecimiento con enlace de un solo uso generado por el admin (sin depender de correo).
const resetLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false,
  keyGenerator: req => ipKeyGenerator(clientIp(req)),
  message: 'Hubo muchos intentos. Inténtalo en 15 minutos.' });
const tokenHash = token => crypto.createHash('sha256').update(String(token)).digest('hex');
const validToken = token => typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token);
const resetInvalid = res => res.status(410).render('reset-password', { title: 'Enlace no válido', csrf: null, valid: false, error: null, token: '' });

router.get('/restablecer/:token', async (req, res) => {
  if (!validToken(req.params.token)) return resetInvalid(res);
  const row = (await pool.query('SELECT 1 FROM tokens_reset WHERE token_hash=$1 AND NOT usado AND expira_at>now()', [tokenHash(req.params.token)])).rows[0];
  if (!row) return resetInvalid(res);
  res.set('Referrer-Policy', 'no-referrer');
  res.render('reset-password', { title: 'Crea una nueva contraseña', csrf: csrfToken(req), valid: true, error: null, token: req.params.token });
});

router.post('/restablecer/:token', resetLimit, async (req, res) => {
  if (!validToken(req.params.token)) return resetInvalid(res);
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const again = () => res.status(400).render('reset-password', { title: 'Crea una nueva contraseña', csrf: csrfToken(req), valid: true, token: req.params.token,
    error: !lengthOk ? 'La contraseña debe tener al menos 8 caracteres (y no más de 72 letras sin tildes).' : 'Las contraseñas no coinciden.' });
  // Mismo límite que el registro: bcrypt solo usa los primeros 72 bytes.
  const lengthOk = password.length >= 8 && Buffer.byteLength(password, 'utf8') <= 72;
  if (!lengthOk || password !== req.body.password2) return again();
  const hash = await bcrypt.hash(password, 12);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const token = (await client.query('SELECT usuario_id FROM tokens_reset WHERE token_hash=$1 AND NOT usado AND expira_at>now() FOR UPDATE', [tokenHash(req.params.token)])).rows[0];
    if (!token) { await client.query('ROLLBACK'); return resetInvalid(res); }
    await client.query('UPDATE tokens_reset SET usado=true WHERE token_hash=$1', [tokenHash(req.params.token)]);
    await client.query('UPDATE usuarios SET password_hash=$1 WHERE id=$2', [hash, token.usuario_id]);
    // Se cierran las sesiones abiertas con la contraseña anterior.
    await client.query("DELETE FROM sesiones WHERE sess->>'userId'=$1", [String(token.usuario_id)]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  res.redirect('/ingresar?restablecida=1');
});

router.get('/privacidad', (_req, res) => res.render('privacy', { title: 'Tratamiento de datos personales' }));

module.exports = { router, csrfToken, verifyCsrf, loadUser, safeNext, requireAuth, requireRole };
