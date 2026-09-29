const express = require('express');
const QRCode = require('qrcode');
const sharp = require('sharp');
const { pool } = require('./db');
const { requireAuth, requireRole, csrfToken } = require('./account');
const { loadConfig } = require('./config');
const { toCsv } = require('./csv');
const { zip } = require('./zip');
const router = express.Router();

// §7: el QR se genera en cada solicitud desde BASE_URL + slug y nunca se guarda.
const QR_OPTIONS = { errorCorrectionLevel: 'Q', margin: 4, color: { dark: '#000000', light: '#FFFFFF' } };
const PNG_SIZE = 1200;
const baseUrl = () => (process.env.BASE_URL || '').replace(/\/$/, '');
const qrUrl = slug => `${baseUrl()}/f/${encodeURIComponent(slug)}?src=qr`;
const id = value => /^\d{1,18}$/.test(String(value)) ? String(value) : null;

// Provisional si la URL no está confirmada, si BASE_URL es local o si la ficha aún no está publicada (su slug puede cambiar).
function provisionalReason(config, research) {
  if (!baseUrl() || /localhost|127\.0\.0\.1/.test(baseUrl())) return 'BASE_URL apunta a localhost';
  if (config.url_qr_confirmada !== true) return 'la URL de los QR no está confirmada';
  if (research.estado_flujo !== 'publicada') return 'la ficha aún no está publicada';
  return null;
}

async function loadPrintable(researchId) {
  const item = (await pool.query(`SELECT i.id,i.slug,i.titulo,i.pregunta_gancho,i.estado_flujo,i.autor_id,i.programa_id,i.territorio_id,
      i.imagen IS NOT NULL AS tiene_imagen,i.qr_verificado_at,p.nombre AS programa,f.id AS facultad_id,f.nombre AS facultad,
      t.nombre AS territorio
    FROM investigaciones i JOIN programas p ON p.id=i.programa_id JOIN facultades f ON f.id=p.facultad_id
    LEFT JOIN territorios t ON t.id=i.territorio_id WHERE i.id=$1`, [researchId])).rows[0];
  if (!item) return null;
  item.investigadores = (await pool.query('SELECT nombre_completo FROM investigadores WHERE investigacion_id=$1 ORDER BY orden,id', [item.id])).rows.map(r => r.nombre_completo);
  return item;
}

async function canAccess(user, item) {
  if (!user || !item || user.estado !== 'activo') return false;
  if (user.rol === 'admin' || String(item.autor_id) === String(user.id)) return true;
  return user.rol === 'coordinador' && (await pool.query('SELECT 1 FROM coordinadores_programa WHERE usuario_id=$1 AND programa_id=$2',
    [user.id, item.programa_id])).rowCount > 0;
}

const qrSvg = slug => QRCode.toString(qrUrl(slug), { ...QR_OPTIONS, type: 'svg' });
const escapeXml = text => String(text).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));

// La marca va en bandas por fuera del código para que el QR provisional se pueda seguir probando.
// Las franjas rojas se ven aunque el servidor no tenga fuentes para el texto.
function bandSvg(width, height, text) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <defs><pattern id="s" width="40" height="40" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="20" height="40" fill="#B00020"/><rect x="20" width="20" height="40" fill="#E0002A"/></pattern></defs>
    <rect width="100%" height="100%" fill="url(#s)"/>
    <rect x="${width * 0.04}" y="${height * 0.18}" width="${width * 0.92}" height="${height * 0.64}" rx="12" fill="#FFFFFF"/>
    <text x="50%" y="50%" dominant-baseline="central" text-anchor="middle" font-family="Roboto, DejaVu Sans, Arial, sans-serif" font-weight="700" font-size="${Math.round(height * 0.34)}" fill="#B00020">${escapeXml(text)}</text>
  </svg>`;
}
const MARK = 'QR PROVISIONAL – NO IMPRIMIR';

async function qrPng(slug, provisional) {
  const png = await QRCode.toBuffer(qrUrl(slug), { ...QR_OPTIONS, type: 'png', width: PNG_SIZE });
  if (!provisional) return png;
  const band = Math.round(PNG_SIZE * 0.12);
  const bandPng = await sharp(Buffer.from(bandSvg(PNG_SIZE, band, MARK))).png().toBuffer();
  return sharp(png).extend({ top: band, bottom: band, background: '#FFFFFF' })
    .composite([{ input: bandPng, top: 0, left: 0 }, { input: bandPng, top: PNG_SIZE + band, left: 0 }]).png().toBuffer();
}

async function qrSvgFile(slug, provisional) {
  const inner = await qrSvg(slug);
  if (!provisional) return inner;
  // Se anida el QR dentro de un SVG más alto con las bandas de aviso arriba y abajo.
  const size = 1000, band = 120;
  const nested = inner.replace('<svg ', `<svg x="0" y="${band}" width="${size}" height="${size}" `);
  const bands = bandSvg(size, band, MARK).replace(/^<svg[^>]*>|<\/svg>$/g, '');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size + band * 2}" width="${size}" height="${size + band * 2}">
    <rect width="100%" height="100%" fill="#FFFFFF"/><g>${bands}</g>${nested}<g transform="translate(0 ${size + band})">${bands.replace('id="s"', 'id="s2"').replace('url(#s)', 'url(#s2)')}</g></svg>`;
}

const fileName = item => `postea-qr-${item.slug}`;

async function itemFor(req, res) {
  const researchId = id(req.params.id);
  const item = researchId && await loadPrintable(researchId);
  if (!item || !await canAccess(req.user, item)) {
    res.status(404).render('not-found', { title: 'Página no encontrada' });
    return null;
  }
  return item;
}

router.get('/investigaciones/:id/qr.:formato', requireAuth, async (req, res) => {
  if (!['png', 'svg'].includes(req.params.formato)) return res.status(404).render('not-found', { title: 'Página no encontrada' });
  const item = await itemFor(req, res);
  if (!item) return;
  const provisional = Boolean(provisionalReason(await loadConfig(), item));
  res.set('Cache-Control', 'no-store');
  if (req.query.descargar === '1') res.attachment(`${fileName(item)}${provisional ? '-PROVISIONAL' : ''}.${req.params.formato}`);
  if (req.params.formato === 'png') return res.type('png').send(await qrPng(item.slug, provisional));
  res.type('image/svg+xml').send(await qrSvgFile(item.slug, provisional));
});

async function piece(item, config) {
  return { ...item, url: qrUrl(item.slug), qr: await qrSvg(item.slug), provisional: provisionalReason(config, item) };
}

// Pieza de medio pliego. El admin la ve en /admin/impresion/:id; el autor y la coordinación, desde su vista previa.
async function renderPieces(req, res, items, back) {
  const config = await loadConfig();
  const pieces = await Promise.all(items.map(item => piece(item, config)));
  res.set('Cache-Control', 'no-store');
  res.render('print-piece', { title: pieces.length === 1 ? `Pieza · ${pieces[0].titulo}` : `Lote de ${pieces.length} piezas`, pieces, back });
}

router.get('/investigaciones/:id/pieza', requireAuth, async (req, res) => {
  const item = await itemFor(req, res);
  if (item) await renderPieces(req, res, [item], req.user.rol === 'coordinador' ? '/coordinacion' : `/panel/investigaciones/${item.id}/vista-previa`);
});

const PRINTABLE = `SELECT i.id FROM investigaciones i JOIN programas p ON p.id=i.programa_id LEFT JOIN territorios t ON t.id=i.territorio_id
  WHERE i.estado_flujo IN ('seleccionada','publicada')`;

router.get('/admin/impresion', requireRole('admin'), async (req, res) => {
  const config = await loadConfig();
  const rows = (await pool.query(`SELECT i.id,i.slug,i.titulo,i.estado_flujo,i.qr_verificado_at,i.imagen IS NOT NULL AS tiene_imagen,
      p.nombre AS programa,t.nombre AS territorio,t.id AS territorio_id
    FROM investigaciones i JOIN programas p ON p.id=i.programa_id LEFT JOIN territorios t ON t.id=i.territorio_id
    WHERE i.estado_flujo IN ('seleccionada','publicada') ORDER BY t.orden NULLS LAST,t.nombre,p.nombre,i.titulo`)).rows;
  res.render('admin-print', { title: 'Impresión · IMAGO', csrf: csrfToken(req), flash: null, items: rows.map(r => ({ ...r, url: qrUrl(r.slug),
    provisional: provisionalReason(config, r) })), baseUrl: baseUrl(), globalReason: provisionalReason(config, { estado_flujo: 'publicada' }) });
});

router.get('/admin/impresion/lote', requireRole('admin'), async (req, res) => {
  const ids = req.query.todas === '1'
    ? (await pool.query(`${PRINTABLE} AND i.estado_flujo='publicada' ORDER BY t.orden NULLS LAST,p.nombre,i.titulo`)).rows.map(r => String(r.id))
    : [...new Set([].concat(req.query.id || []).map(id).filter(Boolean))].slice(0, 100);
  if (!ids.length) return res.redirect('/admin/impresion');
  const items = (await Promise.all(ids.map(loadPrintable))).filter(Boolean);
  await renderPieces(req, res, items, '/admin/impresion');
});

router.get('/admin/impresion/qr.zip', requireRole('admin'), async (req, res) => {
  const config = await loadConfig();
  const rows = (await pool.query(`SELECT i.id,i.slug,i.titulo,i.estado_flujo,p.nombre AS programa,t.nombre AS territorio
    FROM investigaciones i JOIN programas p ON p.id=i.programa_id LEFT JOIN territorios t ON t.id=i.territorio_id
    WHERE i.estado_flujo='publicada' ORDER BY p.nombre,i.titulo`)).rows;
  const files = [];
  for (const row of rows) {
    const provisional = Boolean(provisionalReason(config, row));
    const name = `${fileName(row)}${provisional ? '-PROVISIONAL' : ''}`;
    files.push({ name: `png/${name}.png`, data: await qrPng(row.slug, provisional) }, { name: `svg/${name}.svg`, data: await qrSvgFile(row.slug, provisional) });
  }
  files.push({ name: 'indice.csv', data: toCsv(rows.map(r => ({ titulo: r.titulo, programa: r.programa, territorio: r.territorio, slug: r.slug,
    url_qr: qrUrl(r.slug), provisional: provisionalReason(config, r) ? 'sí' : 'no' }))) });
  const stamp = new Date().toISOString().slice(0, 10);
  res.set('Cache-Control', 'no-store').attachment(`postea-qr-${stamp}${provisionalReason(config, { estado_flujo: 'publicada' }) ? '-PROVISIONAL' : ''}.zip`)
    .type('application/zip').send(zip(files));
});

// Va después de /lote y /qr.zip para que esas rutas no se lean como un id.
router.get('/admin/impresion/:id', requireRole('admin'), async (req, res) => {
  const item = await itemFor(req, res);
  if (item) await renderPieces(req, res, [item], '/admin/impresion');
});

// Coordinación (o admin) confirma que escaneó el QR y abre la ficha correcta.
router.post('/coordinacion/investigaciones/:id/verificar-qr', requireRole('coordinador', 'admin'), async (req, res) => {
  const item = await itemFor(req, res);
  if (!item) return;
  const back = req.user.rol === 'admin' && req.body.volver === 'impresion' ? '/admin/impresion' : '/coordinacion';
  if (item.estado_flujo !== 'publicada') return res.status(409).render('review-notice', { title: 'Revisa esta acción', back,
    message: 'Solo se puede verificar el QR de una ficha publicada.' });
  const undo = req.body.accion === 'desmarcar';
  await pool.query('UPDATE investigaciones SET qr_verificado_at=$1 WHERE id=$2', [undo ? null : new Date(), item.id]);
  res.redirect(`${back}?resultado=${undo ? 'qr-desmarcado' : 'qr-verificado'}`);
});

module.exports = { router, qrUrl, provisionalReason };
