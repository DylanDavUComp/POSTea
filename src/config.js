const { pool } = require('./db');

const TZ = 'America/Bogota';

// Las fechas sin hora se interpretan como el inicio del día en Bogotá (UTC-5, sin horario de verano).
function parseDate(value) {
  if (typeof value !== 'string') return null;
  const date = new Date(value.length === 10 ? `${value}T00:00:00-05:00` : value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function formatDay(date) {
  return date ? new Intl.DateTimeFormat('es-CO', { timeZone: TZ, day: 'numeric', month: 'long' }).format(date) : '';
}

// "27 al 30 de octubre" dentro del mismo mes; "28 de septiembre al 3 de octubre" entre meses.
function rangeLabel(start, end) {
  const from = formatDay(start), to = formatDay(end);
  if (!end || from === to) return from;
  const [fromDay, ...fromMonth] = from.split(' ');
  return fromMonth.join(' ') === to.split(' ').slice(1).join(' ') ? `${fromDay} al ${to}` : `${from} al ${to}`;
}

async function loadConfig() {
  const { rows } = await pool.query('SELECT clave, valor FROM configuracion');
  return Object.fromEntries(rows.map(row => [row.clave, row.valor]));
}

function schedule(config, now = new Date()) {
  const opening = parseDate(config.fecha_apertura);
  const closing = parseDate(config.fecha_cierre);
  const exhibitionStart = parseDate(config.fecha_exhibicion_inicio);
  const exhibitionEnd = parseDate(config.fecha_exhibicion_fin);
  const day = 24 * 60 * 60 * 1000;
  const productionStart = closing && new Date(closing.getTime() + 60 * 1000);
  const productionEnd = exhibitionStart && new Date(exhibitionStart.getTime() - day);
  // `until` delimita la etapa activa; `end` solo se usa para la etiqueta visible.
  const milestones = [
    { name: 'Apertura de convocatoria', detail: 'Los autores crean y envían sus fichas.', start: opening, until: closing },
    { name: 'Cierre de convocatoria', detail: 'Los programas seleccionan sus tres investigaciones.', start: closing },
    { name: 'Producción', detail: 'IMAGO revisa, genera los QR y prepara las piezas.', start: productionStart, end: productionEnd, until: exhibitionStart },
    { name: 'Exhibición', detail: 'Invierte, comenta y conecta en el piso 10.', start: exhibitionStart, end: exhibitionEnd, until: exhibitionEnd }
  ].map(item => ({ ...item, label: rangeLabel(item.start, item.end),
    current: Boolean(item.start && item.until && now >= item.start && now <= item.until) }));
  const exhibition = { start: exhibitionStart, end: exhibitionEnd,
    active: Boolean(exhibitionStart && exhibitionEnd && now >= exhibitionStart && now <= exhibitionEnd),
    ended: Boolean(exhibitionEnd && now > exhibitionEnd) };
  return { milestones, exhibition };
}

// Mensaje amable para acciones que dependen de fecha o de un flag (regla de negocio 9).
function participation(config, flag, noun, now = new Date()) {
  const { exhibition } = schedule(config, now);
  if (config[flag] !== true) return { open: false, message: `${noun} no está disponible en este momento.` };
  if (exhibition.ended) return { open: false, message: `${noun} cerró el ${formatDay(exhibition.end)}. ¡Gracias por participar!` };
  if (!exhibition.active) return { open: false, message: `${noun} se activa el ${formatDay(exhibition.start)}.` };
  return { open: true, message: '' };
}

module.exports = { TZ, parseDate, formatDay, loadConfig, schedule, participation };
