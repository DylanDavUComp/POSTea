require('dotenv').config({ quiet: true });
const bcrypt = require('bcrypt');
const { pool } = require('../src/db');

const EMAIL = 'autor.demo@example.com';
const PROGRAM = 'DEMO · Programa de prueba';

function bogotaDate(date) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(date);
  const get = type => parts.find(part => part.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

async function seedDemo() {
  if (process.env.NODE_ENV === 'production') throw new Error('La semilla DEMO no se puede ejecutar en producción.');
  if (!process.env.DEMO_AUTHOR_PASSWORD || process.env.DEMO_AUTHOR_PASSWORD.length < 12) {
    throw new Error('Configura DEMO_AUTHOR_PASSWORD (mínimo 12 caracteres) en .env.');
  }
  const hash = await bcrypt.hash(process.env.DEMO_AUTHOR_PASSWORD, 12);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const faculty = await client.query("SELECT id FROM facultades WHERE nombre = 'Facultad de Ingeniería'");
    if (!faculty.rowCount) throw new Error('Ejecuta npm run migrate primero.');
    let program = await client.query('SELECT id FROM programas WHERE nombre = $1', [PROGRAM]);
    if (!program.rowCount) {
      program = await client.query(`INSERT INTO programas(nombre, facultad_id) VALUES ($1,$2) RETURNING id`, [PROGRAM, faculty.rows[0].id]);
    }
    const programId = program.rows[0].id;
    const user = await client.query('SELECT id FROM usuarios WHERE email = $1 FOR UPDATE', [EMAIL]);
    if (user.rowCount) {
      await client.query(`UPDATE usuarios SET password_hash=$1, rol='autor', estado='activo', programa_id=$2 WHERE id=$3`,
        [hash, programId, user.rows[0].id]);
    } else {
      await client.query(`INSERT INTO usuarios
        (nombre,email,password_hash,rol,estado,tipo_persona,programa_id,acepta_datos_at,acepta_datos_version)
        VALUES ('Autor DEMO',$1,$2,'autor','activo','investigador',$3,now(),'2026-pruebas-01')`,
        [EMAIL, hash, programId]);
    }
    const today = bogotaDate(new Date());
    const plannedClose = '2026-10-19T23:59:00-05:00';
    const close = new Date(plannedClose) > new Date() ? plannedClose :
      `${bogotaDate(new Date(Date.now() + 30 * 24 * 60 * 60 * 1000))}T23:59:00-05:00`;
    await client.query(`INSERT INTO configuracion(clave,valor) VALUES
      ('fecha_apertura',$1::jsonb),('fecha_cierre',$2::jsonb)
      ON CONFLICT (clave) DO UPDATE SET valor=EXCLUDED.valor`,
      [JSON.stringify(today), JSON.stringify(close)]);
    await client.query('COMMIT');
    console.log(`Programa: ${PROGRAM}`);
    console.log(`Autor: ${EMAIL}`);
    console.log(`Convocatoria local DEMO abierta de ${today} a ${close.slice(0, 10)}.`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

seedDemo().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => pool.end());
