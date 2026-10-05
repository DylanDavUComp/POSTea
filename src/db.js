require('dotenv').config({ quiet: true });
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  throw new Error('Falta DATABASE_URL. Copia .env.example a .env y configura PostgreSQL.');
}

// SSL, en orden de prioridad:
// 1. DB_SSL=true|false lo fuerza.
// 2. sslmode en la URL (disable → sin SSL; require/prefer/verify-* → con SSL).
// 3. Si no se indica nada: SSL solo con NODE_ENV=production (comportamiento anterior).
// El sslmode se quita de la URL y lo aplicamos aquí: pg trataría sslmode=require como verify-full.
// DB_SSL_REJECT_UNAUTHORIZED=true valida el certificado del servidor (por defecto no, como en Render).
function connectionConfig(raw) {
  let connectionString = raw, sslmode = null;
  try {
    const url = new URL(raw);
    sslmode = url.searchParams.get('sslmode');
    url.searchParams.delete('sslmode');
    connectionString = url.toString();
  } catch { /* URL no estándar: pg la interpreta tal cual */ }
  const flag = (process.env.DB_SSL || '').trim().toLowerCase();
  const useSsl = ['true', '1', 'yes'].includes(flag) ? true
    : ['false', '0', 'no'].includes(flag) ? false
    : sslmode ? sslmode !== 'disable'
    : process.env.NODE_ENV === 'production';
  const ssl = useSsl ? { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED === 'true' } : false;
  return { connectionString, ssl };
}

const pool = new Pool({
  ...connectionConfig(process.env.DATABASE_URL),
  // Plan gratuito: pocas conexiones bastan y dejan margen en la base de Render.
  max: Math.min(Number(process.env.DB_POOL_MAX) || 5, 20),
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 30000
});
// Sin este manejador, una conexión inactiva cortada por la base (reinicio, mantenimiento de Render) tumba el proceso.
// El pool descarta esa conexión y abre otra en la siguiente consulta.
pool.on('error', error => console.error('Conexión a la base interrumpida:', error.message));

// ¿El error es porque la base no está disponible (arranque, mantenimiento, red), y no por la consulta?
// Códigos de red de Node y SQLSTATE de PostgreSQL: 57P01-57P03 (apagado o arranque), 53300 (sin conexiones), 08xxx.
const UNAVAILABLE = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'EPIPE',
  '57P01', '57P02', '57P03', '53300', '08000', '08001', '08003', '08004', '08006']);
function isDbUnavailable(error) {
  return Boolean(error) && (UNAVAILABLE.has(error.code) ||
    /Connection terminated|timeout exceeded when trying to connect|Client has encountered a connection error/i.test(error.message || ''));
}

module.exports = { pool, isDbUnavailable };
