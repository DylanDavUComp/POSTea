const crypto = require('node:crypto');
const express = require('express');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const { z } = require('zod');
const { pool } = require('./db');
const { loadConfig, participation } = require('./config');
const router = express.Router();

const COMMENT_TYPES = { pregunta: 'Pregunta', conexion: 'Conexión', aplicacion: 'Posible aplicación' };
const COMMENTS_PER_HOUR = 10;
const QUICK_AMOUNTS = [5, 10, 20, 50];

class ActionError extends Error {}

// En el campus muchas personas comparten la misma IP: los límites se cuentan por cuenta.
const perUser = (windowMs, limit, message) => rateLimit({ windowMs, limit, standardHeaders: 'draft-8', legacyHeaders: false,
  keyGenerator: req => req.user ? `u${req.user.id}` : ipKeyGenerator(req.ip),
  handler: (req, res) => req.params.slug
    ? flashBack(req, res, req.params.slug, { tipo: 'error', texto: message }, req.path.endsWith('/comentar') ? 'comenta' : 'invierte')
    : res.status(429).render('error', { title: 'Espera un momento', message }) });
const investLimit = perUser(10 * 60 * 1000, 30, 'Hiciste muchas inversiones seguidas. Espera unos minutos.');
const commentLimit = perUser(10 * 60 * 1000, 20, 'Enviaste muchos comentarios seguidos. Espera unos minutos.');
const reportLimit = perUser(60 * 60 * 1000, 30, 'Hiciste muchos reportes. Inténtalo más tarde.');

const coinName = config => (typeof config.nombre_moneda === 'string' && config.nombre_moneda) || 'Imagos';
const initialCoins = config => Number.isInteger(config.saldo_inicial_monedas) && config.saldo_inicial_monedas > 0 ? config.saldo_inicial_monedas : 0;
const operationId = () => crypto.randomUUID();
const validOperation = value => typeof value === 'string' && /^[0-9a-f-]{36}$/.test(value) ? value : null;

// Nombre corto para mostrar en público: "María R."
function publicName(nombre) {
  const [first = 'Participante', second] = String(nombre).trim().split(/\s+/);
  return second ? `${first} ${second[0].toUpperCase()}.` : first;
}

const normalize = text => String(text).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
function blockedWord(text, words) {
  if (!Array.isArray(words) || !words.length) return null;
  const tokens = new Set(normalize(text).split(/[^a-z0-9ñ]+/).filter(Boolean));
  return words.map(normalize).find(word => word && [word, `${word}s`, `${word}es`].some(form => tokens.has(form))) || null;
}

function flashBack(req, res, slug, flash, block = 'invierte') {
  if (req.session) req.session.flash = { bloque: block, ...flash };
  res.redirect(`/f/${encodeURIComponent(slug)}#${block}`);
}

async function balance(client, userId, config) {
  const spent = (await client.query('SELECT coalesce(sum(monedas),0)::int AS n FROM inversiones WHERE usuario_id=$1', [userId])).rows[0].n;
  return Math.max(0, initialCoins(config) - spent);
}

async function publishedBySlug(client, slug) {
  return (await client.query(`SELECT id,slug,autor_id FROM investigaciones WHERE slug=$1 AND estado_flujo='publicada'`, [slug])).rows[0];
}

// Regla 6: la fila del usuario se bloquea para que inversiones simultáneas se atiendan en fila y nunca dejen saldo negativo.
async function invest({ userId, slug, coins, operation }) {
  const config = await loadConfig();
  const status = participation(config, 'inversion_activa', 'La inversión');
  if (!status.open) throw new ActionError(status.message);
  if (!Number.isInteger(coins) || coins < 1) throw new ActionError('Elige cuántas monedas quieres invertir.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM usuarios WHERE id=$1 FOR UPDATE', [userId]);
    const research = await publishedBySlug(client, slug);
    if (!research) throw new ActionError('Esta investigación ya no está disponible.');
    if (String(research.autor_id) === String(userId)) throw new ActionError('No puedes invertir en una investigación de la que eres autor.');
    if (operation && (await client.query('SELECT 1 FROM inversiones WHERE usuario_id=$1 AND operacion=$2', [userId, operation])).rowCount) {
      await client.query('ROLLBACK');
      return { duplicate: true, coins, balance: await balance(pool, userId, config), name: coinName(config) };
    }
    const available = await balance(client, userId, config);
    if (available < 1) throw new ActionError(`Ya invertiste todas tus ${coinName(config)}. ¡Gracias por apoyar las ideas!`);
    if (coins > available) throw new ActionError(`Solo te quedan ${available} ${coinName(config)}. Elige una cantidad menor.`);
    await client.query('INSERT INTO inversiones(usuario_id,investigacion_id,monedas,operacion) VALUES($1,$2,$3,$4)',
      [userId, research.id, coins, operation]);
    await client.query('COMMIT');
    return { duplicate: false, coins, balance: available - coins, name: coinName(config) };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

const commentSchema = z.object({
  tipo: z.enum(Object.keys(COMMENT_TYPES), { error: 'Elige si es una pregunta, una conexión o una posible aplicación.' }),
  texto: z.string().trim().min(3, 'Escribe tu comentario (mínimo 3 caracteres).').max(500, 'El comentario puede tener hasta 500 caracteres.')
});

async function comment({ userId, slug, body, operation }) {
  const config = await loadConfig();
  const status = participation(config, 'comentarios_activos', 'El espacio de comentarios');
  if (!status.open) throw new ActionError(status.message);
  const parsed = commentSchema.safeParse({ tipo: body.tipo, texto: typeof body.texto === 'string' ? body.texto : '' });
  if (!parsed.success) throw new ActionError(parsed.error.issues[0].message);
  if (blockedWord(parsed.data.texto, config.palabras_bloqueadas)) {
    throw new ActionError('Tu comentario tiene palabras que no están permitidas. Ajústalo y vuelve a enviarlo.');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM usuarios WHERE id=$1 FOR UPDATE', [userId]);
    const research = await publishedBySlug(client, slug);
    if (!research) throw new ActionError('Esta investigación ya no está disponible.');
    if (operation && (await client.query('SELECT 1 FROM comentarios WHERE usuario_id=$1 AND operacion=$2', [userId, operation])).rowCount) {
      await client.query('ROLLBACK');
      return { duplicate: true, pending: config.moderacion_previa === true };
    }
    const recent = (await client.query(`SELECT count(*)::int AS n FROM comentarios WHERE usuario_id=$1 AND created_at>now()-interval '1 hour'`, [userId])).rows[0].n;
    if (recent >= COMMENTS_PER_HOUR) throw new ActionError(`Puedes dejar hasta ${COMMENTS_PER_HOUR} comentarios por hora. Vuelve en un rato.`);
    const pending = config.moderacion_previa === true;
    await client.query('INSERT INTO comentarios(usuario_id,investigacion_id,tipo,texto,estado,operacion) VALUES($1,$2,$3,$4,$5,$6)',
      [userId, research.id, parsed.data.tipo, parsed.data.texto, pending ? 'pendiente' : 'visible', operation]);
    await client.query('COMMIT');
    return { duplicate: false, pending };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

// Datos de participación para la ficha pública.
async function fichePanel(item, user, config) {
  const [totals, comments, wallet] = await Promise.all([
    pool.query('SELECT coalesce(sum(monedas),0)::int AS monedas, count(DISTINCT usuario_id)::int AS personas FROM inversiones WHERE investigacion_id=$1', [item.id]),
    pool.query(`SELECT c.id,c.tipo,c.texto,c.estado,c.created_at,c.usuario_id,u.nombre,
        EXISTS (SELECT 1 FROM reportes_comentario r WHERE r.comentario_id=c.id AND r.usuario_id=$2) AS reportado_por_mi
      FROM comentarios c JOIN usuarios u ON u.id=c.usuario_id
      WHERE c.investigacion_id=$1 AND (c.estado='visible' OR (c.usuario_id=$2 AND c.estado IN ('pendiente','reportado')))
      ORDER BY c.created_at DESC LIMIT 50`, [item.id, user?.id || null]),
    user ? balance(pool, user.id, config) : null
  ]);
  return {
    totals: totals.rows[0], wallet, coinName: coinName(config), initialCoins: initialCoins(config), quickAmounts: QUICK_AMOUNTS, commentTypes: COMMENT_TYPES,
    comments: comments.rows.map(c => ({ ...c, autor: publicName(c.nombre), mio: user && String(c.usuario_id) === String(user.id) })),
    isAuthor: Boolean(user && String(item.autor_id) === String(user.id)),
    operation: user ? operationId() : null
  };
}

function coinsFrom(body) {
  const raw = typeof body.monedas_otra === 'string' && body.monedas_otra.trim() ? body.monedas_otra : body.monedas;
  return typeof raw === 'string' && /^\d{1,6}$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
}

// Sin cuenta: el formulario llega aquí por GET (sin estado ni CSRF) y se reenvía al registro con la intención en `next`.
router.get('/f/:slug/participar', (req, res) => {
  const slug = req.params.slug.slice(0, 180);
  const coins = coinsFrom(req.query);
  const target = req.query.accion === 'comentar'
    ? `/f/${encodeURIComponent(slug)}${COMMENT_TYPES[req.query.tipo] ? `?tipo=${req.query.tipo}` : ''}#comenta`
    : `/f/${encodeURIComponent(slug)}${Number.isInteger(coins) && coins > 0 ? `?confirmar=${coins}` : ''}#invierte`;
  res.redirect(req.user ? target : `/registro?next=${encodeURIComponent(target)}`);
});

const needUser = block => (req, res, next) => req.user ? next()
  : res.redirect(`/ingresar?next=${encodeURIComponent(`/f/${encodeURIComponent(req.params.slug)}#${block}`)}`);

router.post('/f/:slug/invertir', needUser('invierte'), investLimit, async (req, res, next) => {
  try {
    const result = await invest({ userId: req.user.id, slug: req.params.slug, coins: coinsFrom(req.body), operation: validOperation(req.body.operacion) });
    flashBack(req, res, req.params.slug, { tipo: 'ok',
      texto: `¡Invertiste ${result.coins} ${result.name} en esta idea! Te quedan ${result.balance}.` });
  } catch (error) {
    if (!(error instanceof ActionError)) return next(error);
    flashBack(req, res, req.params.slug, { tipo: 'error', texto: error.message });
  }
});

router.post('/f/:slug/comentar', needUser('comenta'), commentLimit, async (req, res, next) => {
  try {
    const result = await comment({ userId: req.user.id, slug: req.params.slug, body: req.body, operation: validOperation(req.body.operacion) });
    flashBack(req, res, req.params.slug, { tipo: 'ok', texto: result.pending
      ? 'Gracias. Tu comentario se publicará cuando IMAGO lo revise.' : '¡Gracias! Tu comentario ya está publicado.' }, 'comenta');
  } catch (error) {
    if (!(error instanceof ActionError)) return next(error);
    flashBack(req, res, req.params.slug, { tipo: 'error', texto: error.message,
      borrador: { tipo: String(req.body.tipo || ''), texto: String(req.body.texto || '').slice(0, 500) } }, 'comenta');
  }
});

router.post('/comentarios/:id/reportar', reportLimit, async (req, res, next) => {
  if (!/^\d{1,18}$/.test(req.params.id)) return res.status(404).render('not-found', { title: 'Página no encontrada' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const row = (await client.query(`SELECT c.id,c.usuario_id,c.estado,c.moderado_at,i.slug FROM comentarios c
      JOIN investigaciones i ON i.id=c.investigacion_id WHERE c.id=$1 AND i.estado_flujo='publicada' FOR UPDATE OF c`, [req.params.id])).rows[0];
    if (!row) { await client.query('ROLLBACK'); return res.status(404).render('not-found', { title: 'Página no encontrada' }); }
    if (!req.user) { await client.query('ROLLBACK'); return res.redirect(`/ingresar?next=${encodeURIComponent(`/f/${row.slug}#comentarios`)}`); }
    if (String(row.usuario_id) === String(req.user.id)) {
      await client.query('ROLLBACK');
      return flashBack(req, res, row.slug, { tipo: 'error', texto: 'No puedes reportar tu propio comentario.' }, 'comentarios');
    }
    await client.query('INSERT INTO reportes_comentario(comentario_id,usuario_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [row.id, req.user.id]);
    // Un comentario reportado sale de la vista pública hasta que IMAGO lo revise; si IMAGO ya lo aprobó, solo se registra el reporte.
    if (row.estado === 'visible' && !row.moderado_at) await client.query(`UPDATE comentarios SET estado='reportado' WHERE id=$1`, [row.id]);
    await client.query('COMMIT');
    flashBack(req, res, row.slug, { tipo: 'ok', texto: 'Gracias por avisarnos. IMAGO revisará este comentario.' }, 'comentarios');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    next(error);
  } finally { client.release(); }
});

module.exports = { router, invest, comment, fichePanel, balance, blockedWord, publicName, coinName, COMMENT_TYPES, ActionError };
