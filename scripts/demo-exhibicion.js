// Solo desarrollo: abre la exhibición desde hoy para probar inversiones y comentarios antes del 27 de octubre.
// `npm run demo:exhibicion -- --restaurar` devuelve las fechas oficiales.
require('dotenv').config({ quiet: true });
const { pool } = require('../src/db');

const OFFICIAL = { fecha_exhibicion_inicio: '2026-10-27', fecha_exhibicion_fin: '2026-10-30T23:59:00-05:00' };

function bogotaDate(date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

async function main() {
  if (process.env.NODE_ENV === 'production') throw new Error('Este script DEMO no se puede ejecutar en producción.');
  const restore = process.argv.includes('--restaurar');
  const values = restore ? OFFICIAL : {
    fecha_exhibicion_inicio: bogotaDate(new Date()),
    fecha_exhibicion_fin: `${bogotaDate(new Date(Date.now() + 14 * 24 * 60 * 60 * 1000))}T23:59:00-05:00`
  };
  for (const [key, value] of Object.entries({ ...values, inversion_activa: true, comentarios_activos: true })) {
    await pool.query(`INSERT INTO configuracion(clave,valor) VALUES($1,$2::jsonb) ON CONFLICT (clave) DO UPDATE SET valor=EXCLUDED.valor`,
      [key, JSON.stringify(value)]);
  }
  console.log(restore ? 'Fechas oficiales de exhibición restauradas (27 al 30 de octubre).'
    : `Exhibición DEMO abierta de ${values.fecha_exhibicion_inicio} a ${values.fecha_exhibicion_fin.slice(0, 10)}.`);
}

main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => pool.end());
