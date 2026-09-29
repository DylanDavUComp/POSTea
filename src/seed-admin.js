const bcrypt = require('bcrypt');
const { pool } = require('./db');

// Crea la cuenta admin inicial desde ADMIN_EMAIL/ADMIN_PASSWORD solo si todavía no existe.
// Nunca cambia la contraseña de una cuenta existente.
async function ensureAdmin({ required = false } = {}) {
  const { ADMIN_EMAIL, ADMIN_PASSWORD } = process.env;
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD || ADMIN_PASSWORD.length < 12) {
    const message = 'Configura ADMIN_EMAIL y ADMIN_PASSWORD (mínimo 12 caracteres) para crear el administrador.';
    if (required) throw new Error(message);
    return { created: false, skipped: message };
  }
  const email = ADMIN_EMAIL.trim().toLowerCase();
  const hash = await bcrypt.hash(ADMIN_PASSWORD, 12);
  // ON CONFLICT: si dos instancias arrancan a la vez, solo una crea la cuenta.
  const result = await pool.query(`INSERT INTO usuarios
    (nombre, email, password_hash, rol, estado, tipo_persona, acepta_datos_at, acepta_datos_version)
    VALUES ($1, $2, $3, 'admin', 'activo', 'administrativo', now(), '2026-01')
    ON CONFLICT ((lower(email))) DO NOTHING`, ['Administración IMAGO', email, hash]);
  return { created: result.rowCount === 1 };
}

module.exports = { ensureAdmin };
