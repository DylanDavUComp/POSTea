const { pool } = require('./db');

const TZ = 'America/Bogota';

// Las fechas se guardan en ISO 8601 con desfase explícito (`2026-10-19T23:59:00-05:00`), así que son instantes absolutos:
// las comparaciones no dependen de la zona horaria del servidor (Render corre en UTC). Bogotá es UTC-5 sin horario de verano.
// Una fecha sin hora es el inicio del día en Bogotá; con `end`, el final de ese día (para cierres escritos a mano).
// Una hora sin desfase también se toma como hora de Bogotá, nunca como hora del servidor.
function parseDate(value, end = false) {
  if (typeof value !== 'string') return null;
  const text = value.length === 10 ? `${value}T${end ? '23:59:59.999' : '00:00:00'}-05:00`
    : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(value) ? `${value}-05:00` : value;
  const date = new Date(text);
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
  const closing = parseDate(config.fecha_cierre, true);
  const exhibitionStart = parseDate(config.fecha_exhibicion_inicio);
  const exhibitionEnd = parseDate(config.fecha_exhibicion_fin, true);
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

// Convocatoria abierta: desde la apertura hasta el cierre, ambos incluidos.
function submissionOpen(config, now = new Date()) {
  const start = parseDate(config.fecha_apertura), end = parseDate(config.fecha_cierre, true);
  return Boolean(start && end && now >= start && now <= end);
}

// URL pública de los QR: sale solo de BASE_URL (variable de entorno), sin "/" final.
const publicBaseUrl = () => (process.env.BASE_URL || '').trim().replace(/\/+$/, '');

// Motivo por el que BASE_URL no sirve para imprimir, o null. No depende de la confirmación del admin.
function baseUrlProblem(url = publicBaseUrl()) {
  if (!url) return 'BASE_URL está vacía';
  let parsed;
  try { parsed = new URL(url); } catch { return 'BASE_URL no es una URL válida'; }
  if (/^(localhost|127\.|0\.0\.0\.0$|\[::1\]$)/.test(parsed.hostname)) return 'BASE_URL apunta a localhost';
  if (parsed.protocol !== 'https:') return 'BASE_URL no usa https://';
  return null;
}

// Motivo por el que los QR siguen provisionales, o null si se pueden imprimir. La confirmación guarda la URL exacta
// (`url_qr_confirmada_para`): si después cambia BASE_URL (p. ej. de onrender.com a un dominio propio), vuelven a ser
// provisionales hasta confirmar la nueva. Una confirmación anterior a este ajuste, sin URL guardada, no cuenta.
function qrUrlProblem(config) {
  const problem = baseUrlProblem();
  if (problem) return problem;
  if (config.url_qr_confirmada !== true) return 'la URL de los QR no está confirmada';
  if (config.url_qr_confirmada_para !== publicBaseUrl()) return 'BASE_URL cambió después de confirmarla';
  return null;
}

// Mensaje amable para acciones que dependen de fecha o de un flag (regla de negocio 9).
function participation(config, flag, noun, now = new Date()) {
  const { exhibition } = schedule(config, now);
  if (config[flag] !== true) return { open: false, message: `${noun} no está disponible en este momento.` };
  if (exhibition.ended) return { open: false, message: `${noun} cerró el ${formatDay(exhibition.end)}. ¡Gracias por participar!` };
  if (!exhibition.active) return { open: false, message: `${noun} se activa el ${formatDay(exhibition.start)}.` };
  return { open: true, message: '' };
}

module.exports = { TZ, parseDate, formatDay, loadConfig, schedule, submissionOpen, participation, publicBaseUrl, baseUrlProblem, qrUrlProblem };
