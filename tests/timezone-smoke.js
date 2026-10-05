// Zona horaria: el servidor de Render corre en UTC; las reglas deben evaluarse en America/Bogota (UTC-5).
// Se fuerza TZ=UTC antes de crear cualquier fecha para que la prueba falle si algo depende de la hora del servidor.
process.env.TZ = 'UTC';
require('dotenv').config({ quiet: true });
process.env.TZ = 'UTC'; // .env podría traer TZ=America/Bogota: la prueba exige UTC.
const assert = require('node:assert/strict');
const { parseDate, schedule, submissionOpen, participation, formatDay } = require('../src/config');
const { pool } = require('../src/db');

const at = iso => new Date(iso);
const config = {
  fecha_apertura: '2026-10-05', fecha_cierre: '2026-10-19T23:59:00-05:00',
  fecha_exhibicion_inicio: '2026-10-27', fecha_exhibicion_fin: '2026-10-30T23:59:00-05:00',
  inversion_activa: true, comentarios_activos: true
};

async function main() {
  assert.equal(new Date(0).getTimezoneOffset(), 0, 'la prueba corre en UTC');

  // Cierre exacto: 19 oct 23:59:00 en Bogotá = 20 oct 04:59:00 UTC. Abierto ese milisegundo, cerrado el siguiente.
  assert.equal(submissionOpen(config, at('2026-10-20T04:59:00.000Z')), true, 'abierta en el instante del cierre');
  assert.equal(submissionOpen(config, at('2026-10-20T04:59:00.001Z')), false, 'cerrada 1 ms después');
  // A las 8 p. m. del 19 en Bogotá ya es 20 en UTC: debe seguir abierta.
  assert.equal(submissionOpen(config, at('2026-10-20T01:00:00Z')), true, '19 oct 8 p. m. Bogotá sigue abierta');
  // Apertura sin hora = 00:00 de Bogotá (05:00 UTC), no medianoche UTC (7 p. m. del día anterior en Bogotá).
  assert.equal(submissionOpen(config, at('2026-10-05T04:59:59.999Z')), false, '4 oct 11:59 p. m. Bogotá aún cerrada');
  assert.equal(submissionOpen(config, at('2026-10-05T05:00:00Z')), true, '5 oct 00:00 Bogotá abierta');
  // Un cierre escrito sin hora vale hasta el final de ese día en Bogotá (antes `new Date('2026-10-19')` era 18 oct 7 p. m.).
  const dateOnly = { ...config, fecha_cierre: '2026-10-19' };
  assert.equal(submissionOpen(dateOnly, at('2026-10-20T04:59:59.999Z')), true, 'cierre sin hora: abierta hasta las 23:59:59 de Bogotá');
  assert.equal(submissionOpen(dateOnly, at('2026-10-20T05:00:00Z')), false);
  assert.equal(submissionOpen(dateOnly, at('2026-10-19T03:00:00Z')), true, '18 oct 10 p. m. Bogotá no se cierra antes de tiempo');
  // Hora sin desfase: se toma como hora de Bogotá, no del servidor.
  assert.equal(parseDate('2026-10-19T23:59').toISOString(), '2026-10-20T04:59:00.000Z');

  // Exhibición e inversión: activas del 27 (00:00 Bogotá) al 30 23:59 Bogotá.
  const before = participation(config, 'inversion_activa', 'La inversión', at('2026-10-27T04:59:59Z'));
  assert.equal(before.open, false); assert.match(before.message, /se activa el 27 de octubre/);
  assert.equal(participation(config, 'inversion_activa', 'La inversión', at('2026-10-27T05:00:00Z')).open, true);
  assert.equal(participation(config, 'inversion_activa', 'La inversión', at('2026-10-31T04:59:00Z')).open, true, '30 oct 11:59 p. m. Bogotá');
  const after = participation(config, 'inversion_activa', 'La inversión', at('2026-10-31T04:59:00.001Z'));
  assert.equal(after.open, false); assert.match(after.message, /cerró el 30 de octubre/);
  assert.equal(participation({ ...config, inversion_activa: false }, 'inversion_activa', 'La inversión', at('2026-10-28T15:00:00Z')).open, false, 'el flag manda');

  // Cronograma de la landing: etapa actual y etiquetas en días de Bogotá.
  const lateClosingDay = schedule(config, at('2026-10-20T03:00:00Z')); // 19 oct 10 p. m. Bogotá
  assert.equal(lateClosingDay.milestones.find(m => m.current)?.name, 'Apertura de convocatoria');
  const production = schedule(config, at('2026-10-22T15:00:00Z'));
  assert.equal(production.milestones.find(m => m.current)?.name, 'Producción');
  assert.equal(production.milestones.find(m => m.name === 'Producción').label, '20 al 26 de octubre');
  assert.equal(formatDay(at('2026-10-20T03:00:00Z')), '19 de octubre', 'formatDay usa Bogotá aunque en UTC ya sea 20');

  // SQL del tablero y de /pantalla ("hoy", escaneos por día): con la sesión de PostgreSQL en UTC, el día es el de Bogotá.
  const client = await pool.connect();
  try {
    await client.query("SET TIME ZONE 'UTC'");
    const { rows } = await client.query(`SELECT ('2026-10-20T03:00:00Z'::timestamptz AT TIME ZONE 'America/Bogota')::date::text AS dia,
      (now() AT TIME ZONE 'America/Bogota')::date = (now() - interval '5 hours')::date AS hoy_bogota`);
    assert.equal(rows[0].dia, '2026-10-19'); assert.equal(rows[0].hoy_bogota, true);
  } finally { client.release(); }

  console.log('Zona horaria OK con TZ=UTC: cierre exacto 23:59:00 Bogotá (abierta en el instante, cerrada 1 ms después), apertura y cierre sin hora, exhibición/inversión, cronograma, formatDay y SQL AT TIME ZONE.');
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => pool.end());
