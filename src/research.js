const crypto = require('node:crypto');
const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
// 512 MB en Render: sin caché de libvips y un hilo por imagen para no agotar la memoria con subidas simultáneas.
sharp.cache(false);
sharp.concurrency(1);
const { z } = require('zod');
const { pool } = require('./db');
const { submissionOpen, loadConfig, parseDate, formatDay } = require('./config');
const { csrfToken, verifyCsrf, requireRole } = require('./account');

const router = express.Router();
// 10 MB: una foto de 12 MP en JPG pesa de 3 a 6 MB. El peso no mide la nitidez; eso lo decide PRINT_IMAGE.
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
// Área de la imagen en la pieza de 50 × 70 cm: todo el ancho y lo que dejan el encabezado, los datos y la barra (~23 cm).
// La imagen se recorta para cubrirla (object-fit: cover), así que la nitidez la fija el lado que queda más justo.
// Nunca se rechaza por resolución: bajo 150 ppp el formulario avisa que se verá borrosa y de 150 a 200 que se verá algo suave.
// Se guarda hasta 200 ppp (más no se nota en papel y solo pesa en la base).
const PRINT_IMAGE = { widthCm: 50, heightCm: 47, minPpi: 150, goodPpi: 200, maxBytes: MAX_IMAGE_BYTES };
const printPpi = (width, height) => Math.floor(Math.min(width / (PRINT_IMAGE.widthCm / 2.54), height / (PRINT_IMAGE.heightCm / 2.54)));
const pixelsAt = ppi => [Math.ceil(PRINT_IMAGE.widthCm / 2.54 * ppi), Math.ceil(PRINT_IMAGE.heightCm / 2.54 * ppi)];
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
  territorio: z.union([z.literal(''), z.literal('otro'), z.string().regex(/^\d{1,18}$/)]),
  territorio_otro: z.string().trim().max(80),
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
  investigadores: 'Escribe hasta seis nombres, uno por línea.',
  territorio: 'Selecciona un territorio válido.',
  territorio_otro: 'El nombre del territorio debe tener máximo 80 caracteres.'
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
    'estado_investigacion', 'tipo', 'imagen_credito', 'sharepoint_url', 'investigadores', 'territorio', 'territorio_otro'];
  const values = Object.fromEntries(names.map(name => [name, typeof body[name] === 'string' ? body[name] : '']));
  values.derechos_imagen_confirmados = body.derechos_imagen_confirmados === 'si';
  values.regenerar_slug = body.regenerar_slug === 'si';
  return values;
}

async function submissionWindowOpen() {
  const result = await pool.query(`SELECT clave, valor FROM configuracion WHERE clave IN ('fecha_apertura', 'fecha_cierre')`);
  // Mismo intérprete que el cronograma: un cierre sin hora (`2026-10-19`) no se lee como medianoche UTC.
  return submissionOpen(Object.fromEntries(result.rows.map(row => [row.clave, row.valor])));
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

// Ficha publicada que IMAGO autorizó a editar: el autor propone cambios que se guardan aparte
// y solo reemplazan la versión pública cuando el admin los aprueba.
function mayEditPublished(user, research) {
  return user.rol === 'autor' && String(research.autor_id) === String(user.id) &&
    research.estado_flujo === 'publicada' && Boolean(research.edicion_autorizada_at);
}

// Valores del formulario a partir de la propuesta guardada (o de la versión publicada si aún no hay propuesta).
function proposalValues(research) {
  const c = research.cambios;
  if (!c) return { ...research };
  return { ...research, ...c, investigadores: (c.investigadores || []).join('\n') };
}

function mayView(user, research) {
  return user.rol === 'admin' || String(research.autor_id) === String(user.id);
}

async function loadResearch(id) {
  const result = await pool.query(`SELECT i.*, p.nombre AS programa_nombre, f.nombre AS facultad_nombre, t.nombre AS territorio_nombre
    FROM investigaciones i JOIN programas p ON p.id = i.programa_id
    JOIN facultades f ON f.id = p.facultad_id LEFT JOIN territorios t ON t.id = i.territorio_id WHERE i.id = $1`, [id]);
  if (!result.rowCount) return null;
  const research = result.rows[0];
  research.investigadores = (await pool.query(`SELECT nombre_completo FROM investigadores
    WHERE investigacion_id = $1 ORDER BY orden, id`, [id])).rows.map(row => row.nombre_completo).join('\n');
  return research;
}

async function imageFromUpload(file) {
  if (!file) return null;
  const unreadable = () => new FormError('La imagen no se pudo leer. Usa JPG, PNG o WebP de hasta 10 MB y 40 megapíxeles.');
  const source = sharp(file.buffer, { limitInputPixels: 40_000_000 });
  const metadata = await source.metadata().catch(() => null);
  if (!metadata || !['jpeg', 'png', 'webp'].includes(metadata.format)) throw unreadable();
  // Las fotos de celular suelen venir giradas por EXIF: se mide como se verá.
  const turned = (metadata.orientation || 1) >= 5;
  const width = turned ? metadata.height : metadata.width, height = turned ? metadata.width : metadata.height;
  // La resolución no bloquea la subida: el formulario avisa al elegirla y aquí solo se evita guardar más de lo que se imprime.
  // Se reduce solo lo que pase de 200 ppp en el lado más justo; el otro lado queda más largo para que el recorte no pierda nitidez.
  const [goodWidth, goodHeight] = pixelsAt(PRINT_IMAGE.goodPpi);
  const scale = Math.min(1, Math.max(goodWidth / width, goodHeight / height));
  try {
    // effort 2: con 0,1 CPU en Render, una imagen de 4000 px tarda la mitad que con el valor por defecto y pesa casi igual.
    return await source.rotate().resize({ width: Math.round(width * scale), withoutEnlargement: true })
      .webp({ quality: 80, effort: 2 }).toBuffer();
  } catch { throw unreadable(); }
}

// En una propuesta de cambios de una ficha publicada el territorio no se edita: lo asignó IMAGO al publicar.
function parseForm(body, existing, newImage, { withTerritory = true } = {}) {
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
    if (withTerritory && !data.territorio) throw new FormError('Selecciona el territorio de tu investigación.');
    if (withTerritory && data.territorio === 'otro' && data.territorio_otro.length < 3) throw new FormError('Escribe el nombre del territorio (mínimo 3 caracteres).');
    if (!newImage && !existing?.tiene_imagen) throw new FormError('Agrega una imagen antes de enviar.');
    if (!raw.derechos_imagen_confirmados) throw new FormError('Confirma que tienes derechos de uso de la imagen.');
  }
  return { ...data, researchers, rights: raw.derechos_imagen_confirmados, regenerateSlug: raw.regenerar_slug };
}

// Territorio elegido por el autor: uno existente (territorio_id) u «Otro» con nombre propio (territorio_propuesto).
// Un borrador puede quedar sin territorio; una ficha publicada siempre necesita uno existente.
async function resolveTerritory(db, data, existing) {
  if (data.territorio === 'otro') {
    if (existing?.estado_flujo === 'publicada') throw new FormError('Una ficha publicada necesita uno de los territorios existentes.');
    return { territorioId: null, propuesto: data.territorio_otro.length >= 3 ? data.territorio_otro : null };
  }
  if (!data.territorio) {
    if (existing?.estado_flujo === 'publicada') throw new FormError('Selecciona el territorio de tu investigación.');
    return { territorioId: null, propuesto: null };
  }
  if (!(await db.query('SELECT 1 FROM territorios WHERE id=$1', [data.territorio])).rowCount) throw new FormError('Selecciona un territorio válido.');
  return { territorioId: data.territorio, propuesto: null };
}

// Valor del selector a partir de lo guardado: el id del territorio, «otro» si propuso uno nuevo, o vacío.
function territoryValues(research) {
  return { territorio: research.territorio_id ? String(research.territorio_id) : research.territorio_propuesto ? 'otro' : '',
    territorio_otro: research.territorio_propuesto || '' };
}

async function renderForm(req, res, { research = null, values = {}, error = null, status = 200, windowOpen = false }) {
  const editingPublished = Boolean(research && mayEditPublished(req.user, research));
  const territories = (await pool.query('SELECT id, nombre FROM territorios ORDER BY orden, nombre')).rows;
  if (research && !('territorio' in values)) values = { ...values, ...territoryValues(research) };
  res.status(status).render('research-form', {
    title: research ? 'Editar investigación' : 'Nueva investigación', research, values, territories,
    csrf: csrfToken(req), error, windowOpen, editingPublished, printImage: { ...PRINT_IMAGE, minPixels: pixelsAt(PRINT_IMAGE.minPpi) },
    imageSrc: research ? `/media/investigaciones/${research.id}${editingPublished && research.cambios_imagen ? '/propuesta' : ''}` : null
  });
}

function uploadAndCsrf(req, res, next) {
  upload(req, res, error => {
    if (error) {
      const message = error.code === 'LIMIT_FILE_SIZE' ? 'La imagen debe pesar máximo 10 MB.' :
        error instanceof FormError ? error.message : 'Revisa el archivo y vuelve a intentarlo.';
      return res.status(400).render('error', { title: 'No se pudo subir la imagen', message });
    }
    verifyCsrf(req, res, next);
  });
}

// Variante para tarjetas y celulares: 1080 px cubren la ficha en un celular de pantalla 3x (unos 360 px de ancho útil)
// y las tarjetas del muro. La original (hasta ~4000 px, 200 ppp en el póster) queda para la pieza impresa y la vista previa.
const MINI_SIZE = 1080;
const miniFrom = image => sharp(image).resize(MINI_SIZE, MINI_SIZE, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 72 }).toBuffer();

async function serveImage(req, res, mini) {
  if (!/^\d+$/.test(req.params.id)) return res.sendStatus(404);
  // Primero solo metadatos y el hash: si el navegador ya tiene la imagen (ETag) respondemos 304 sin leer los bytes.
  const result = await pool.query(`SELECT md5(imagen) AS hash, estado_flujo, autor_id, programa_id, imagen_mini IS NOT NULL AS tiene_mini
    FROM investigaciones WHERE id = $1`, [req.params.id]);
  const item = result.rows[0];
  const coordinatorAccess = item && req.user?.rol === 'coordinador' && req.user.estado === 'activo' &&
    !['borrador','archivada'].includes(item.estado_flujo) && (await pool.query(
      'SELECT 1 FROM coordinadores_programa WHERE usuario_id=$1 AND programa_id=$2', [req.user.id, item.programa_id])).rowCount > 0;
  if (!item?.hash || (item.estado_flujo !== 'publicada' && req.user?.rol !== 'admin' && String(req.user?.id) !== String(item.autor_id) && !coordinatorAccess)) return res.sendStatus(404);
  // Caché corta con ETag: si IMAGO aprueba una imagen nueva, el público la ve en minutos y no al día siguiente.
  res.set('Cache-Control', item.estado_flujo === 'publicada' ? 'public, max-age=300' : 'private, no-store');
  res.set('ETag', `"${item.hash}${mini ? '-m' : ''}"`);
  res.type('image/webp');
  if (req.fresh) return res.sendStatus(304);
  if (!mini) return res.send((await pool.query('SELECT imagen FROM investigaciones WHERE id=$1', [req.params.id])).rows[0].imagen);
  if (item.tiene_mini) return res.send((await pool.query('SELECT imagen_mini FROM investigaciones WHERE id=$1', [req.params.id])).rows[0].imagen_mini);
  // Primera vez: se genera y se guarda. Solo si la imagen sigue siendo la misma (md5): una edición simultánea gana.
  const { imagen } = (await pool.query('SELECT imagen FROM investigaciones WHERE id=$1', [req.params.id])).rows[0];
  const small = await miniFrom(imagen);
  await pool.query('UPDATE investigaciones SET imagen_mini=$1 WHERE id=$2 AND md5(imagen)=$3', [small, req.params.id, item.hash]);
  res.send(small);
}

router.get('/media/investigaciones/:id', (req, res) => serveImage(req, res, false));
router.get('/media/investigaciones/:id/mini', (req, res) => serveImage(req, res, true));

// Imagen propuesta en una edición autorizada: solo el autor y el admin, nunca en público.
router.get('/media/investigaciones/:id/propuesta', async (req, res) => {
  if (!/^\d+$/.test(req.params.id) || !req.user) return res.sendStatus(404);
  const item = (await pool.query('SELECT cambios_imagen, autor_id FROM investigaciones WHERE id=$1', [req.params.id])).rows[0];
  if (!item?.cambios_imagen || (req.user.rol !== 'admin' && String(req.user.id) !== String(item.autor_id))) return res.sendStatus(404);
  res.set('Cache-Control', 'private, no-store');
  res.type('image/webp').send(item.cambios_imagen);
});

router.use('/panel', requireRole('autor', 'admin'));

router.get('/panel', async (req, res) => {
  const rows = (await pool.query(`SELECT id, titulo, slug, estado_flujo, observaciones_revision, updated_at,
      edicion_autorizada_at, cambios_estado, cambios_observaciones
    FROM investigaciones WHERE autor_id = $1 ORDER BY updated_at DESC`, [req.user.id])).rows;
  const windowOpen = await submissionWindowOpen();
  const config = await loadConfig();
  const opening = parseDate(config.fecha_apertura), closing = parseDate(config.fecha_cierre, true);
  // Antes de la apertura: "abre el …"; después del cierre: "cerró el …".
  const windowNote = windowOpen ? null : opening && new Date() < opening ? `abre el ${formatDay(opening)}` : closing ? `cerró el ${formatDay(closing)}` : 'no está abierta';
  const quota = req.user.programa_id ? await programQuota(pool, req.user.programa_id) : null;
  res.render('panel', { title: 'Mis investigaciones', rows, windowOpen, windowNote, quota, quotaMessage: quota?.full ? quotaMessage(quota) : null,
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
    const territory = await resolveTerritory(client, data, null);
    const saved = await client.query(`INSERT INTO investigaciones
      (slug, programa_id, autor_id, titulo, subtitulo, pregunta_gancho, descripcion, objetivo, metodologia,
       resultados, estado_investigacion, tipo, imagen, imagen_mime, imagen_credito, derechos_imagen_confirmados,
       sharepoint_url, estado_flujo, territorio_id, territorio_propuesto)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING id`,
      [slugFrom(data.titulo), req.user.programa_id, req.user.id, data.titulo, data.subtitulo || null,
        data.pregunta_gancho || null, data.descripcion || null, data.objetivo || null, data.metodologia || null,
        data.resultados || null, data.estado_investigacion || null, data.tipo || null, image,
        image ? 'image/webp' : null, data.imagen_credito || null, data.rights,
        data.sharepoint_url || null, data.intent === 'enviar' ? 'enviada' : 'borrador', territory.territorioId, territory.propuesto]);
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
  if (mayEditPublished(req.user, research)) return renderForm(req, res, { research, values: proposalValues(research), windowOpen: await submissionWindowOpen() });
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
    if (mayEditPublished(req.user, current)) {
      // Propuesta de cambios: se valida completa (la ficha ya es pública) y no toca la versión publicada ni el enlace.
      const data = parseForm(req.body, current, image, { withTerritory: false });
      const proposal = { titulo: data.titulo, subtitulo: data.subtitulo || null, pregunta_gancho: data.pregunta_gancho || null,
        descripcion: data.descripcion, objetivo: data.objetivo, metodologia: data.metodologia, resultados: data.resultados,
        estado_investigacion: data.estado_investigacion, tipo: data.tipo, imagen_credito: data.imagen_credito || null,
        sharepoint_url: data.sharepoint_url || null, investigadores: data.researchers, derechos_imagen_confirmados: data.rights };
      const send = data.intent === 'enviar';
      await client.query(`UPDATE investigaciones SET cambios=$1, cambios_imagen=COALESCE($2,cambios_imagen),
        cambios_estado=$3, cambios_enviados_at=CASE WHEN $3='enviada' THEN now() ELSE cambios_enviados_at END,
        cambios_observaciones=CASE WHEN $3='enviada' THEN NULL ELSE cambios_observaciones END WHERE id=$4`,
      [JSON.stringify(proposal), image, send ? 'enviada' : (current.cambios_estado === 'devuelta' ? 'devuelta' : 'borrador'), current.id]);
      await client.query('COMMIT');
      return res.redirect(`/panel/investigaciones/${current.id}/vista-previa?resultado=${send ? 'cambios-enviados' : 'cambios-guardados'}`);
    }
    if (!mayEdit(req.user, current)) throw new FormError('No puedes editar esta ficha.', 403);
    const data = parseForm(req.body, current, image);
    if (data.intent === 'enviar' && !['borrador', 'devuelta'].includes(current.estado_flujo)) throw new FormError('Esta ficha ya fue enviada.');
    if (data.intent === 'enviar' && req.user.rol !== 'admin' && !windowOpen) throw new FormError('La convocatoria para enviar fichas no está activa.');
    const slug = data.regenerateSlug && current.estado_flujo === 'borrador' ? slugFrom(data.titulo) : current.slug;
    const nextState = data.intent === 'enviar' ? 'enviada' : current.estado_flujo;
    const territory = await resolveTerritory(client, data, current);
    await client.query(`UPDATE investigaciones SET slug=$1, titulo=$2, subtitulo=$3, pregunta_gancho=$4,
      descripcion=$5, objetivo=$6, metodologia=$7, resultados=$8, estado_investigacion=$9, tipo=$10,
      imagen=COALESCE($11,imagen), imagen_mime=CASE WHEN $11::bytea IS NULL THEN imagen_mime ELSE 'image/webp' END,
      imagen_credito=$12, derechos_imagen_confirmados=$13, sharepoint_url=$14, estado_flujo=$15,
      observaciones_revision=CASE WHEN $15 = 'enviada' THEN NULL ELSE observaciones_revision END,
      territorio_id=$17, territorio_propuesto=$18, updated_at=now() WHERE id=$16`,
      [slug, data.titulo, data.subtitulo || null, data.pregunta_gancho || null, data.descripcion || null,
        data.objetivo || null, data.metodologia || null, data.resultados || null,
        data.estado_investigacion || null, data.tipo || null, image, data.imagen_credito || null,
        data.rights, data.sharepoint_url || null, nextState, req.params.id, territory.territorioId, territory.propuesto]);
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
    resultado: ['guardada', 'enviada', 'cambios-guardados', 'cambios-enviados'].includes(req.query.resultado) ? req.query.resultado : null,
    canEdit: mayEdit(req.user, research) || mayEditPublished(req.user, research), windowOpen: await submissionWindowOpen() });
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
