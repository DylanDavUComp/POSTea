// Datos de operación para el tablero del admin: vencimiento y tamaño de la base gratuita de Render y diagnóstico del proxy.
const { pool } = require('./db');
const { parseDate } = require('./config');
const { clientIp } = require('./client-ip');

const DAY = 24 * 60 * 60 * 1000;
const MB = 1024 * 1024;

// DB_EXPIRA_EN (AAAA-MM-DD, fecha de Render → postea-db → "Expires"). La base Free vence 30 días después de creada.
// Nivel: ok, warn (menos de 7 días), danger (2 días o menos, o vencida).
// También compara con el fin de la exhibición + un margen para exportar (DB_MARGEN_EXPORTAR_DIAS, 3 por defecto).
function dbExpiry(config, now = new Date(), env = process.env) {
  const marginDays = Number(env.DB_MARGEN_EXPORTAR_DIAS) || 3;
  const exhibitionEnd = parseDate(config.fecha_exhibicion_fin, true);
  const needed = exhibitionEnd && new Date(exhibitionEnd.getTime() + marginDays * DAY);
  const daysNeeded = needed ? Math.ceil((needed - now) / DAY) : null;
  const raw = (env.DB_EXPIRA_EN || '').trim();
  const base = { marginDays, exhibitionEnd, needed, daysNeeded };
  if (!raw) return { ...base, configured: false, level: env.NODE_ENV === 'production' ? 'warn' : 'ok' };
  const date = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? parseDate(raw) : null;
  if (!date) return { ...base, configured: false, invalid: raw, level: 'warn' };
  const daysLeft = Math.ceil((date - now) / DAY);
  const coversEvent = needed ? date >= needed : null;
  const level = daysLeft <= 2 ? 'danger' : daysLeft < 7 || coversEvent === false ? 'warn' : 'ok';
  return { ...base, configured: true, date, daysLeft, coversEvent, level };
}

// Tamaño de la base y de las tablas más grandes. Alerta al pasar del 70 % del límite (DB_LIMITE_MB, 1024 en Free).
async function dbSize(env = process.env) {
  const limitBytes = (Number(env.DB_LIMITE_MB) || 1024) * MB;
  const [total, tables] = await Promise.all([
    pool.query('SELECT pg_database_size(current_database())::bigint AS bytes'),
    pool.query(`SELECT c.relname AS tabla, pg_total_relation_size(c.oid)::bigint AS bytes
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind='r' ORDER BY 2 DESC LIMIT 6`)
  ]);
  const bytes = Number(total.rows[0].bytes);
  const percent = Math.round(bytes / limitBytes * 1000) / 10;
  return { bytes, limitBytes, percent, level: percent >= 90 ? 'danger' : percent >= 70 ? 'warn' : 'ok',
    tables: tables.rows.map(r => ({ tabla: r.tabla, bytes: Number(r.bytes) })) };
}

// Cómo ve la app esta solicitud: sirve para comprobar en Render que los límites usan la IP real y no la del proxy.
function proxyDiagnostics(req) {
  const forwarded = String(req.get('x-forwarded-for') || '').split(',').map(x => x.trim()).filter(Boolean);
  return { clientIp: clientIp(req), reqIp: req.ip, secure: req.secure, forwarded,
    header: (process.env.CLIENT_IP_HEADER || '').trim().toLowerCase() || null,
    headerValue: process.env.CLIENT_IP_HEADER ? req.get(process.env.CLIENT_IP_HEADER) || null : null,
    trustProxy: req.app.get('trust proxy') };
}

function formatBytes(bytes) {
  if (bytes >= MB) return `${(bytes / MB).toFixed(bytes >= 100 * MB ? 0 : 1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

module.exports = { dbExpiry, dbSize, proxyDiagnostics, formatBytes };
