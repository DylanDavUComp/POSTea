const express = require('express');
const { z } = require('zod');
const { pool } = require('./db');
const { requireRole, csrfToken } = require('./account');
const router = express.Router();

class ReviewError extends Error {
  constructor(message, status = 409) { super(message); this.status = status; }
}

async function canCoordinate(client, user, programId) {
  if (user.rol === 'admin') return true;
  return user.rol === 'coordinador' && (await client.query(
    'SELECT 1 FROM coordinadores_programa WHERE usuario_id=$1 AND programa_id=$2', [user.id, programId]
  )).rowCount > 0;
}

function showError(res, error, back) {
  if (!(error instanceof ReviewError)) throw error;
  return res.status(error.status).render('review-notice', { title: 'Revisa esta acción', message: error.message, back });
}

router.get('/coordinacion', requireRole('coordinador', 'admin'), async (req, res) => {
  const programs = (await pool.query(`SELECT p.*,
    (SELECT count(*)::int FROM investigaciones i WHERE i.programa_id=p.id AND i.estado_flujo IN ('seleccionada','publicada')) AS seleccionadas
    FROM programas p WHERE $1::boolean OR EXISTS
    (SELECT 1 FROM coordinadores_programa cp WHERE cp.programa_id=p.id AND cp.usuario_id=$2)
    ORDER BY p.nombre`, [req.user.rol === 'admin', req.user.id])).rows;
  const ids = programs.map(p => p.id);
  const authors = (await pool.query(`SELECT id,nombre,email,programa_id FROM usuarios
    WHERE rol='autor' AND estado='pendiente' AND programa_id=ANY($1::bigint[]) ORDER BY created_at`, [ids])).rows;
  const research = (await pool.query(`SELECT i.id,i.titulo,i.slug,i.qr_verificado_at,i.programa_id,i.estado_flujo,i.observaciones_revision,u.nombre AS autor
    FROM investigaciones i JOIN usuarios u ON u.id=i.autor_id
    WHERE i.programa_id=ANY($1::bigint[]) AND i.estado_flujo IN ('enviada','seleccionada','devuelta','publicada')
    ORDER BY i.updated_at DESC`, [ids])).rows;
  const messages = { activado: 'Autor activado.', rechazado: 'Solicitud de autor rechazada.', seleccionada: 'Ficha seleccionada para revisión de IMAGO.', devuelta: 'Ficha devuelta al autor con tus observaciones.',
    'qr-verificado': 'QR marcado como verificado.', 'qr-desmarcado': 'Se quitó la verificación del QR.' };
  const base = (process.env.BASE_URL || '').replace(/\/$/, '');
  res.render('coordination', { title: 'Coordinación', programs, authors, research, csrf: csrfToken(req), message: messages[req.query.resultado] || null,
    qrUrl: slug => `${base}/f/${encodeURIComponent(slug)}?src=qr` });
});

router.post('/coordinacion/autores/:id/:accion', requireRole('coordinador', 'admin'), async (req, res) => {
  if (!/^\d+$/.test(req.params.id) || !['activar','rechazar'].includes(req.params.accion)) return res.sendStatus(404);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const author = (await client.query('SELECT * FROM usuarios WHERE id=$1 FOR UPDATE', [req.params.id])).rows[0];
    if (!author || !await canCoordinate(client, req.user, author.programa_id)) throw new ReviewError('No tienes acceso a ese autor.', 403);
    if (author.rol !== 'autor' || author.estado !== 'pendiente') throw new ReviewError('Esta solicitud ya fue revisada.');
    await client.query('UPDATE usuarios SET estado=$1 WHERE id=$2', [req.params.accion === 'activar' ? 'activo' : 'bloqueado', author.id]);
    await client.query('COMMIT');
    res.redirect('/coordinacion?resultado=' + (req.params.accion === 'activar' ? 'activado' : 'rechazado'));
  } catch (error) {
    await client.query('ROLLBACK');
    return showError(res, error, '/coordinacion');
  } finally { client.release(); }
});

router.get('/coordinacion/investigaciones/:id', requireRole('coordinador', 'admin'), async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.sendStatus(404);
  const research = (await pool.query(`SELECT i.*,p.nombre AS programa_nombre,f.nombre AS facultad_nombre
    FROM investigaciones i JOIN programas p ON p.id=i.programa_id JOIN facultades f ON f.id=p.facultad_id WHERE i.id=$1`, [req.params.id])).rows[0];
  if (!research || !await canCoordinate(pool, req.user, research.programa_id) ||
      (req.user.rol !== 'admin' && ['borrador','archivada'].includes(research.estado_flujo))) return res.sendStatus(404);
  research.investigadores = (await pool.query('SELECT nombre_completo FROM investigadores WHERE investigacion_id=$1 ORDER BY orden,id', [research.id])).rows.map(r => r.nombre_completo).join('\n');
  res.render('research-preview', { title: 'Revisar ficha', research, csrf: csrfToken(req), canEdit: false, windowOpen: false, resultado: null, backUrl: '/coordinacion' });
});

router.get('/admin/investigaciones', requireRole('admin'), async (req, res) => {
  const research = (await pool.query(`SELECT i.id,i.titulo,i.estado_flujo,i.territorio_id,i.slug,p.nombre AS programa,u.nombre AS autor
    FROM investigaciones i JOIN programas p ON p.id=i.programa_id JOIN usuarios u ON u.id=i.autor_id ORDER BY i.updated_at DESC`)).rows;
  const territories = (await pool.query('SELECT id,nombre FROM territorios ORDER BY orden,nombre')).rows;
  const messages = { publicada: 'Ficha publicada. Su enlace queda fijo.', archivada: 'Ficha archivada.' };
  res.render('review-admin', { title: 'Publicación IMAGO', research, territories, csrf: csrfToken(req), message: messages[req.query.resultado] || null });
});

// Todas las transiciones de selección/publicación bloquean primero el programa.
// Así el conteo del cupo se mantiene consistente aun con solicitudes simultáneas.
async function transition(req, res, administrative) {
  const action = req.params.accion;
  const allowed = administrative ? ['publicar','archivar'] : ['seleccionar','devolver'];
  const back = administrative ? '/admin/investigaciones' : '/coordinacion';
  if (!/^\d+$/.test(req.params.id) || !allowed.includes(action)) return res.sendStatus(404);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const initial = (await client.query('SELECT programa_id FROM investigaciones WHERE id=$1', [req.params.id])).rows[0];
    if (!initial) throw new ReviewError('No encontramos esa ficha.', 404);
    if (!administrative && !await canCoordinate(client, req.user, initial.programa_id)) throw new ReviewError('No tienes acceso a ese programa.', 403);
    const program = (await client.query('SELECT cupo FROM programas WHERE id=$1 FOR UPDATE', [initial.programa_id])).rows[0];
    const item = (await client.query('SELECT * FROM investigaciones WHERE id=$1 FOR UPDATE', [req.params.id])).rows[0];
    if (!item || String(item.programa_id) !== String(initial.programa_id)) throw new ReviewError('La ficha cambió. Actualiza la página.');
    let result;
    if (action === 'seleccionar') {
      if (item.estado_flujo !== 'enviada') throw new ReviewError('Solo se pueden seleccionar fichas enviadas.');
      const count = (await client.query(`SELECT count(*)::int AS n FROM investigaciones
        WHERE programa_id=$1 AND estado_flujo IN ('seleccionada','publicada')`, [item.programa_id])).rows[0].n;
      if (count >= program.cupo) throw new ReviewError(`El programa ya tiene ${count} de ${program.cupo} investigaciones seleccionadas o publicadas. El cupo está completo.`);
      await client.query("UPDATE investigaciones SET estado_flujo='seleccionada', observaciones_revision=NULL, updated_at=now() WHERE id=$1", [item.id]);
      result = 'seleccionada';
    } else if (action === 'devolver') {
      if (!['enviada','seleccionada'].includes(item.estado_flujo)) throw new ReviewError('Esta ficha no está disponible para devolución.');
      const parsed = z.string().trim().min(10).max(1000).safeParse(req.body.observaciones);
      if (!parsed.success) throw new ReviewError('Escribe observaciones de entre 10 y 1000 caracteres para orientar al autor.', 400);
      await client.query("UPDATE investigaciones SET estado_flujo='devuelta', observaciones_revision=$1, updated_at=now() WHERE id=$2", [parsed.data, item.id]);
      result = 'devuelta';
    } else if (action === 'publicar') {
      if (item.estado_flujo !== 'seleccionada') throw new ReviewError('La ficha debe estar seleccionada por coordinación antes de publicarla.');
      const territory = z.string().regex(/^\d+$/).safeParse(req.body.territorio_id);
      if (!territory.success || !(await client.query('SELECT 1 FROM territorios WHERE id=$1', [territory.data])).rowCount) throw new ReviewError('Selecciona un territorio válido.', 400);
      await client.query("UPDATE investigaciones SET estado_flujo='publicada',territorio_id=$1,publicada_at=COALESCE(publicada_at,now()),updated_at=now() WHERE id=$2", [territory.data, item.id]);
      result = 'publicada';
    } else {
      if (!['seleccionada','publicada'].includes(item.estado_flujo)) throw new ReviewError('Solo se pueden archivar fichas seleccionadas o publicadas.');
      await client.query("UPDATE investigaciones SET estado_flujo='archivada',updated_at=now() WHERE id=$1", [item.id]);
      result = 'archivada';
    }
    await client.query('COMMIT');
    res.redirect(`${back}?resultado=${result}`);
  } catch (error) {
    await client.query('ROLLBACK');
    return showError(res, error, back);
  } finally { client.release(); }
}

router.post('/coordinacion/investigaciones/:id/:accion', requireRole('coordinador', 'admin'), (req, res) => transition(req, res, false));
router.post('/admin/investigaciones/:id/:accion', requireRole('admin'), (req, res) => transition(req, res, true));

module.exports = router;
