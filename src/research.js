const crypto = require('node:crypto');
const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const { z } = require('zod');
const { pool } = require('./db');
const { csrfToken, verifyCsrf, requireRole } = require('./account');

const router = express.Router();
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGE_BYTES, files: 1, fields: 20, fieldSize: 2000 },
  fileFilter: (_req, file, done) => IMAGE_TYPES.has(file.mimetype)
    ? done(null, true) : done(new FormError('La imagen debe ser JPG, PNG o WebP.'))
}).single('imagen');

const fields = z.object({
  titulo: z.string().trim().min(1).max(90),
  subtitulo: z.string().trim().max(180),
  pregunta_gancho: z.string().trim().max(80),
  descripcion: z.string().trim().max(900),
  objetivo: z.string().trim().max(900),
  metodologia: z.string().trim().max(900),
  resultados: z.string().trim().max(900),
  estado_investigacion: z.enum(['', 'terminada', 'en_desarrollo']),
  tipo: z.enum(['', 'investigacion', 'semillero', 'proyecto_grado', 'pasantia']),
  imagen_credito: z.string().trim().max(180),
  sharepoint_url: z.union([z.literal(''), z.url().refine(x => x.startsWith('https://'))]),
  investigadores: z.string().trim().max(900),
  intent: z.enum(['borrador', 'enviar'])
});

const fieldNames = {
  titulo: 'El título es obligatorio y debe tener máximo 90 caracteres.',
  subtitulo: 'El subtítulo debe tener máximo 180 caracteres.',
  pregunta_gancho: 'La pregunta del post debe tener máximo 80 caracteres.',
  descripcion: 'La descripción debe tener máximo 900 caracteres.',
  objetivo: 'El objetivo debe tener máximo 900 caracteres.',
  metodologia: 'La metodología debe tener máximo 900 caracteres.',
  resultados: 'Los resultados deben tener máximo 900 caracteres.',
  estado_investigacion: 'Selecciona el estado de la investigación.',
  tipo: 'Selecciona el tipo de investigación.',
  imagen_credito: 'El crédito de imagen debe tener máximo 180 caracteres.',
  sharepoint_url: 'El enlace a SharePoint debe empezar con https://.',
  investigadores: 'Escribe hasta seis nombres, uno por línea.'
};

class FormError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

// Slug corto (m\u00e1x. 40 caracteres cortando en palabra completa): una URL m\u00e1s corta da un QR con m\u00f3dulos m\u00e1s grandes,
// que se lee mejor a distancia desde el vidrio.
function slugFrom(title) {
  const full = title.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const cut = full.length <= 40 ? full : (full.slice(0, 41).replace(/-[^-]*$/, '') || full).slice(0, 40);
  const base = cut.replace(/-$/g, '') || 'investigacion';
  return `${base}-${crypto.randomBytes(3).toString('hex')}`;
}

function splitResearchers(value) {
  return value.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
}

function formValues(body = {}) {
  const names = ['titulo', 'subtitulo', 'pregunta_gancho', 'descripcion', 'objetivo', 'metodologia', 'resultados',
    'estado_investigacion', 'tipo', 'imagen_credito', 'sharepoint_url', 'investigadores'];
  const values = Object.fromEntries(names.map(name => [name, typeof body[name] === 'string' ? body[name] : '']));
  values.derechos_imagen_confirmados = body.derechos_imagen_confirmados === 'si';
  values.regenerar_slug = body.regenerar_slug === 'si';
  return values;
}

async function submissionWindowOpen() {
  const result = await pool.query(`SELECT clave, valor FROM configuracion WHERE clave IN ('fecha_apertura', 'fecha_cierre')`);
  const config = Object.fromEntries(result.rows.map(row => [row.clave, row.valor]));
  const start = new Date(String(config.fecha_apertura).length === 10 ? `${config.fecha_apertura}T00:00:00-05:00` : config.fecha_apertura);
  const end = new Date(config.fecha_cierre);
  return Number.isFinite(start.getTime()) && Number.isFinite(end.getTime()) && Date.now() >= start && Date.now() <= end;
}

// Cupo de registro: fichas no archivadas del programa. Ampliarlo es una gestión interna con IMAGO, no desde la página.
// Con lock, bloquea la fila del programa (igual que la selección) para que dos creaciones simultáneas no pasen el cupo.
async function programQuota(db, programId, lock = false) {
  const program = (await db.query(`SELECT cupo FROM programas WHERE id=$1${lock ? ' FOR UPDATE' : ''}`, [programId])).rows[0];
  const used = (await db.query(`SELECT count(*)::int AS n FROM investigaciones
    WHERE programa_id=$1 AND estado_flujo<>'archivada'`, [programId])).rows[0].n;
  const cupo = program?.cupo ?? 0;
  return { cupo, registradas: used, full: used >= cupo };
}

const quotaMessage = quota => `Tu programa ya registró ${quota.registradas} de ${quota.cupo} proyectos, el máximo permitido. ` +
  'Si necesita más cupos, la dirección del programa debe solicitarlo a IMAGO por los canales internos.';

function mayEdit(user, research) {
  return user.rol === 'admin' ||
    (user.rol === 'autor' && String(research.autor_id) === String(user.id) &&
      String(research.programa_id) === String(user.programa_id) &&
      ['borrador', 'devuelta'].includes(research.estado_flujo));
}

function mayView(user, research) {
  return user.rol === 'admin' || String(research.autor_id) === String(user.id);
}

async function loadResearch(id) {
  const result = await pool.query(`SELECT i.*, p.nombre AS programa_nombre, f.nombre AS facultad_nombre
    FROM investigaciones i JOIN programas p ON p.id = i.programa_id
    JOIN facultades f ON f.id = p.facultad_id WHERE i.id = $1`, [id]);
  if (!result.rowCount) return null;
  const research = result.rows[0];
  research.investigadores = (await pool.query(`SELECT nombre_completo FROM investigadores
    WHERE investigacion_id = $1 ORDER BY orden, id`, [id])).rows.map(row => row.nombre_completo).join('\n');
  return research;
}

async function imageFromUpload(file) {
  if (!file) return null;
  try {
    const source = sharp(file.buffer, { limitInputPixels: 40_000_000 });
    const metadata = await source.metadata();
    if (!['jpeg', 'png', 'webp'].includes(metadata.format)) throw new Error('Formato no admitido');
    const image = await source.rotate().resize(1600, 1600, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 80 }).toBuffer();
    return image;
  } catch { throw new FormError('La imagen no se pudo leer. Usa JPG, PNG o WebP de hasta 5 MB.'); }
}

function parseForm(body, existing, newImage) {
  const raw = formValues(body);
  const parsed = fields.safeParse({ ...raw, intent: body.intent });
  if (!parsed.success) throw new FormError(fieldNames[parsed.error.issues[0]?.path?.[0]] || 'Revisa el formulario.');
  const data = parsed.data;
  const researchers = splitResearchers(data.investigadores);
  if (researchers.length > 6 || researchers.some(name => name.length > 120)) throw new FormError('Escribe entre 1 y 6 investigadores, uno por línea y con máximo 120 caracteres cada nombre.');
  if (data.intent === 'enviar' || (existing && !['borrador', 'devuelta'].includes(existing.estado_flujo))) {
    if (!data.pregunta_gancho) throw new FormError('Escribe la pregunta o frase del post.');
    const sectionNames = { descripcion: 'La descripción', objetivo: 'El objetivo', metodologia: 'La metodología', resultados: 'Los resultados' };
    for (const name of Object.keys(sectionNames)) {
      if (data[name].length < 80) throw new FormError(`${sectionNames[name]} necesita al menos 80 caracteres para enviar; ahora tiene ${data[name].length}.`);
    }
    if (!data.estado_investigacion || !data.tipo) throw new FormError('Selecciona el estado y el tipo de investigación.');
    if (researchers.length < 1) throw new FormError('Agrega al menos un investigador.');
    if (!newImage && !existing?.tiene_imagen) throw new FormError('Agrega una imagen antes de enviar.');
    if (!raw.derechos_imagen_confirmados) throw new FormError('Confirma que tienes derechos de uso de la imagen.');
  }
  return { ...data, researchers, rights: raw.derechos_imagen_confirmados, regenerateSlug: raw.regenerar_slug };
}

function renderForm(req, res, { research = null, values = {}, error = null, status = 200, windowOpen = false }) {
  res.status(status).render('research-form', {
    title: research ? 'Editar investigación' : 'Nueva investigación', research, values,
    csrf: csrfToken(req), error, windowOpen
  });
}

function uploadAndCsrf(req, res, next) {
  upload(req, res, error => {
    if (error) {
      const message = error.code === 'LIMIT_FILE_SIZE' ? 'La imagen debe pesar máximo 5 MB.' :
        error instanceof FormError ? error.message : 'Revisa el archivo y vuelve a intentarlo.';
      return res.status(400).render('error', { title: 'No se pudo subir la imagen', message });
    }
    verifyCsrf(req, res, next);
  });
}

router.get('/media/investigaciones/:id', async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.sendStatus(404);
  const result = await pool.query('SELECT imagen, imagen_mime, estado_flujo, autor_id, programa_id FROM investigaciones WHERE id = $1', [req.params.id]);
  const item = result.rows[0];
  const coordinatorAccess = item && req.user?.rol === 'coordinador' && req.user.estado === 'activo' &&
    !['borrador','archivada'].includes(item.estado_flujo) && (await pool.query(
      'SELECT 1 FROM coordinadores_programa WHERE usuario_id=$1 AND programa_id=$2', [req.user.id, item.programa_id])).rowCount > 0;
  if (!item?.imagen || (item.estado_flujo !== 'publicada' && req.user?.rol !== 'admin' && String(req.user?.id) !== String(item.autor_id) && !coordinatorAccess)) return res.sendStatus(404);
  res.set('Cache-Control', item.estado_flujo === 'publicada' ? 'public, max-age=86400' : 'private, no-store');
  res.type('image/webp').send(item.imagen);
});

router.use('/panel', requireRole('autor', 'admin'));

router.get('/panel', async (req, res) => {
  const rows = (await pool.query(`SELECT id, titulo, slug, estado_flujo, observaciones_revision, updated_at
    FROM investigaciones WHERE autor_id = $1 ORDER BY updated_at DESC`, [req.user.id])).rows;
  const windowOpen = await submissionWindowOpen();
  const quota = req.user.programa_id ? await programQuota(pool, req.user.programa_id) : null;
  res.render('panel', { title: 'Mis investigaciones', rows, windowOpen, quota, quotaMessage: quota?.full ? quotaMessage(quota) : null,
    canCreate: Boolean(quota) && !quota.full && (req.user.rol === 'admin' || windowOpen), csrf: csrfToken(req) });
});

router.get('/panel/investigaciones/nueva', async (req, res) => {
  const windowOpen = await submissionWindowOpen();
  if (!req.user.programa_id) return res.status(400).render('error', { title: 'Falta programa', message: 'Necesitas un programa para crear una investigación.' });
  if (req.user.rol !== 'admin' && !windowOpen) return res.status(403).render('error', { title: 'Convocatoria cerrada', message: 'La convocatoria para crear fichas aún no está abierta o ya terminó.' });
  const quota = await programQuota(pool, req.user.programa_id);
  if (quota.full) return res.status(409).render('error', { title: 'Cupo completo', message: quotaMessage(quota) });
  renderForm(req, res, { windowOpen });
});

router.post('/panel/investigaciones/nueva', requireRole('autor', 'admin'), uploadAndCsrf, async (req, res) => {
  const windowOpen = await submissionWindowOpen();
  if (!req.user.programa_id || (req.user.rol !== 'admin' && !windowOpen)) return res.status(403).render('error', {
    title: 'Convocatoria cerrada', message: 'Ahora no se pueden crear fichas.'
  });
  let client;
  try {
    const image = await imageFromUpload(req.file);
    const data = parseForm(req.body, null, image);
    client = await pool.connect();
    await client.query('BEGIN');
    const quota = await programQuota(client, req.user.programa_id, true);
    if (quota.full) throw new FormError(quotaMessage(quota), 409);
    const saved = await client.query(`INSERT INTO investigaciones
      (slug, programa_id, autor_id, titulo, subtitulo, pregunta_gancho, descripcion, objetivo, metodologia,
       resultados, estado_investigacion, tipo, imagen, imagen_mime, imagen_credito, derechos_imagen_confirmados,
       sharepoint_url, estado_flujo)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING id`,
      [slugFrom(data.titulo), req.user.programa_id, req.user.id, data.titulo, data.subtitulo || null,
        data.pregunta_gancho || null, data.descripcion || null, data.objetivo || null, data.metodologia || null,
        data.resultados || null, data.estado_investigacion || null, data.tipo || null, image,
        image ? 'image/webp' : null, data.imagen_credito || null, data.rights,
        data.sharepoint_url || null, data.intent === 'enviar' ? 'enviada' : 'borrador']);
    for (const [index, name] of data.researchers.entries()) {
      await client.query('INSERT INTO investigadores(investigacion_id, nombre_completo, orden) VALUES ($1,$2,$3)', [saved.rows[0].id, name, index]);
    }
    await client.query('COMMIT');
    res.redirect(`/panel/investigaciones/${saved.rows[0].id}/vista-previa?resultado=${data.intent === 'enviar' ? 'enviada' : 'guardada'}`);
  } catch (error) {
    if (client) await client.query('ROLLBACK');
    if (error instanceof FormError) return renderForm(req, res, { values: formValues(req.body), error: error.message, status: error.status, windowOpen });
    throw error;
  } finally { client?.release(); }
});

router.get('/panel/investigaciones/:id/editar', async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.sendStatus(404);
  const research = await loadResearch(req.params.id);
  if (!research) return res.sendStatus(404);
  if (!mayEdit(req.user, research)) return res.status(403).render('error', { title: 'Sin permiso', message: 'No puedes editar esta ficha.' });
  renderForm(req, res, { research, values: { ...research, derechos_imagen_confirmados: research.derechos_imagen_confirmados },
    windowOpen: await submissionWindowOpen() });
});

router.post('/panel/investigaciones/:id/editar', requireRole('autor', 'admin'), uploadAndCsrf, async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.sendStatus(404);
  let client;
  let current;
  const windowOpen = await submissionWindowOpen();
  try {
    const image = await imageFromUpload(req.file);
    client = await pool.connect();
    await client.query('BEGIN');
    const found = await client.query('SELECT *, (imagen IS NOT NULL) AS tiene_imagen FROM investigaciones WHERE id = $1 FOR UPDATE', [req.params.id]);
    current = found.rows[0];
    if (!current) throw new FormError('No encontramos esa ficha.', 404);
    if (!mayEdit(req.user, current)) throw new FormError('No puedes editar esta ficha.', 403);
    const data = parseForm(req.body, current, image);
    if (data.intent === 'enviar' && !['borrador', 'devuelta'].includes(current.estado_flujo)) throw new FormError('Esta ficha ya fue enviada.');
    if (data.intent === 'enviar' && req.user.rol !== 'admin' && !windowOpen) throw new FormError('La convocatoria para enviar fichas no está activa.');
    const slug = data.regenerateSlug && current.estado_flujo === 'borrador' ? slugFrom(data.titulo) : current.slug;
    const nextState = data.intent === 'enviar' ? 'enviada' : current.estado_flujo;
    await client.query(`UPDATE investigaciones SET slug=$1, titulo=$2, subtitulo=$3, pregunta_gancho=$4,
      descripcion=$5, objetivo=$6, metodologia=$7, resultados=$8, estado_investigacion=$9, tipo=$10,
      imagen=COALESCE($11,imagen), imagen_mime=CASE WHEN $11::bytea IS NULL THEN imagen_mime ELSE 'image/webp' END,
      imagen_credito=$12, derechos_imagen_confirmados=$13, sharepoint_url=$14, estado_flujo=$15,
      observaciones_revision=CASE WHEN $15 = 'enviada' THEN NULL ELSE observaciones_revision END,
      updated_at=now() WHERE id=$16`,
      [slug, data.titulo, data.subtitulo || null, data.pregunta_gancho || null, data.descripcion || null,
        data.objetivo || null, data.metodologia || null, data.resultados || null,
        data.estado_investigacion || null, data.tipo || null, image, data.imagen_credito || null,
        data.rights, data.sharepoint_url || null, nextState, req.params.id]);
    await client.query('DELETE FROM investigadores WHERE investigacion_id = $1', [req.params.id]);
    for (const [index, name] of data.researchers.entries()) {
      await client.query('INSERT INTO investigadores(investigacion_id, nombre_completo, orden) VALUES ($1,$2,$3)', [req.params.id, name, index]);
    }
    await client.query('COMMIT');
    res.redirect(`/panel/investigaciones/${req.params.id}/vista-previa?resultado=${data.intent === 'enviar' ? 'enviada' : 'guardada'}`);
  } catch (error) {
    if (client) await client.query('ROLLBACK');
    if (error instanceof FormError) {
      if (error.status === 404 || error.status === 403) return res.status(error.status).render('error', { title: 'No se pudo editar', message: error.message });
      const research = current || await loadResearch(req.params.id);
      if (!research) return res.sendStatus(404);
      return renderForm(req, res, { research, values: formValues(req.body), error: error.message,
        status: error.status, windowOpen });
    }
    throw error;
  } finally { client?.release(); }
});

router.get('/panel/investigaciones/:id/vista-previa', async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.sendStatus(404);
  const research = await loadResearch(req.params.id);
  if (!research) return res.sendStatus(404);
  if (!mayView(req.user, research)) return res.status(403).render('error', { title: 'Sin permiso', message: 'No puedes ver esta ficha.' });
  res.render('research-preview', { title: 'Vista previa de investigación', research, csrf: csrfToken(req),
    resultado: ['guardada', 'enviada'].includes(req.query.resultado) ? req.query.resultado : null,
    canEdit: mayEdit(req.user, research), windowOpen: await submissionWindowOpen() });
});

router.post('/panel/investigaciones/:id/eliminar', async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.sendStatus(404);
  const result = await pool.query(`DELETE FROM investigaciones WHERE id=$1 AND autor_id=$2
    AND estado_flujo IN ('borrador','devuelta') RETURNING id`, [req.params.id, req.user.id]);
  if (!result.rowCount) return res.status(403).render('error', { title: 'No se pudo eliminar', message: 'Solo puedes eliminar tus borradores o fichas devueltas.' });
  res.redirect('/panel');
});

module.exports = router;
// Expuesto para pruebas.
module.exports.slugFrom = slugFrom;
