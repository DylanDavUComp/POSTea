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
  const research = (await pool.query(`SELECT i.id,i.titulo,i.estado_flujo,i.territorio_id,i.slug,i.observaciones_revision,
      i.edicion_autorizada_at,i.cambios_estado,i.cambios_enviados_at,i.cambios_observaciones,
      p.nombre AS programa,p.cupo,u.nombre AS autor,
      (SELECT count(*)::int FROM investigaciones o WHERE o.programa_id=i.programa_id AND o.estado_flujo IN ('seleccionada','publicada')) AS ocupados
    FROM investigaciones i JOIN programas p ON p.id=i.programa_id JOIN usuarios u ON u.id=i.autor_id ORDER BY i.updated_at DESC`)).rows;
  const territories = (await pool.query('SELECT id,nombre FROM territorios ORDER BY orden,nombre')).rows;
  const messages = { publicada: 'Ficha aprobada y publicada. Ya está en el muro y su enlace queda fijo.', archivada: 'Ficha archivada.',
    devuelta: 'Ficha devuelta al autor con tus observaciones.',
    'edicion-autorizada': 'Edición autorizada. El autor ya puede proponer cambios; la ficha pública sigue igual hasta que los apruebes.',
    'edicion-revocada': 'Se retiró la autorización de edición y se descartaron los cambios no aprobados.',
    'cambios-publicados': 'Cambios aprobados y publicados. La ficha pública ya muestra la versión nueva.',
    'cambios-devueltos': 'Cambios devueltos al autor con tus observaciones. La ficha pública sigue igual.' };
  const groups = {
    pending: research.filter(r => ['enviada', 'seleccionada'].includes(r.estado_flujo)),
    changes: research.filter(r => r.estado_flujo === 'publicada' && r.cambios_estado === 'enviada'),
    published: research.filter(r => r.estado_flujo === 'publicada'),
    other: research.filter(r => ['borrador', 'devuelta', 'archivada'].includes(r.estado_flujo))
  };
  res.render('review-admin', { title: 'Publicación IMAGO', groups, territories, csrf: csrfToken(req), message: messages[req.query.resultado] || null });
});

// Revisión de los cambios propuestos para una ficha publicada, tal como se verían al aprobarlos.
router.get('/admin/investigaciones/:id/cambios', requireRole('admin'), async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.sendStatus(404);
  const research = (await pool.query(`SELECT i.*,p.nombre AS programa_nombre,f.nombre AS facultad_nombre
    FROM investigaciones i JOIN programas p ON p.id=i.programa_id JOIN facultades f ON f.id=p.facultad_id WHERE i.id=$1`, [req.params.id])).rows[0];
  if (!research?.cambios) return res.status(404).render('not-found', { title: 'Página no encontrada' });
  const current = { ...research, investigadores: (await pool.query('SELECT nombre_completo FROM investigadores WHERE investigacion_id=$1 ORDER BY orden,id', [research.id])).rows.map(r => r.nombre_completo).join('\n') };
  const proposed = { ...research, ...research.cambios, investigadores: (research.cambios.investigadores || []).join('\n'), estado_flujo: 'cambios propuestos' };
  const labels = { titulo: 'Título', subtitulo: 'Subtítulo', pregunta_gancho: 'Pregunta del post', descripcion: 'Descripción', objetivo: 'Objetivo',
    metodologia: 'Metodología', resultados: 'Resultados', estado_investigacion: 'Estado', tipo: 'Tipo', imagen_credito: 'Crédito de imagen',
    sharepoint_url: 'Enlace SharePoint', investigadores: 'Investigadores' };
  const changed = Object.keys(labels).filter(key => String(current[key] ?? '') !== String(proposed[key] ?? '')).map(key => labels[key]);
  if (research.cambios_imagen) changed.push('Imagen');
  res.render('research-preview', { title: 'Revisar cambios', research: proposed, csrf: csrfToken(req), canEdit: false, windowOpen: false, resultado: null,
    backUrl: '/admin/investigaciones', imageSrc: research.cambios_imagen ? `/media/investigaciones/${research.id}/propuesta` : null, changed });
});

// Todas las transiciones de selección/publicación bloquean primero el programa.
// Así el conteo del cupo se mantiene consistente aun con solicitudes simultáneas.
async function transition(req, res, administrative) {
  const action = req.params.accion;
  const allowed = administrative
    ? ['publicar','archivar','devolver','autorizar-edicion','revocar-edicion','aprobar-cambios','devolver-cambios']
    : ['seleccionar','devolver'];
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
      // Aprobar = publicar en un solo paso. IMAGO puede aprobar una ficha enviada directamente (sin esperar la
      // selección de coordinación) o una ya seleccionada; el cupo del programa se respeta igual.
      if (!['enviada','seleccionada'].includes(item.estado_flujo)) throw new ReviewError('Solo se pueden aprobar fichas enviadas o seleccionadas.');
      const territory = z.string().regex(/^\d+$/).safeParse(req.body.territorio_id);
      if (!territory.success || !(await client.query('SELECT 1 FROM territorios WHERE id=$1', [territory.data])).rowCount) throw new ReviewError('Selecciona un territorio válido.', 400);
      if (item.estado_flujo === 'enviada') {
        const count = (await client.query(`SELECT count(*)::int AS n FROM investigaciones
          WHERE programa_id=$1 AND estado_flujo IN ('seleccionada','publicada')`, [item.programa_id])).rows[0].n;
        if (count >= program.cupo) throw new ReviewError(`El programa ya tiene ${count} de ${program.cupo} investigaciones aprobadas. El cupo está completo.`);
      }
      await client.query("UPDATE investigaciones SET estado_flujo='publicada',territorio_id=$1,observaciones_revision=NULL,publicada_at=COALESCE(publicada_at,now()),updated_at=now() WHERE id=$2", [territory.data, item.id]);
      result = 'publicada';
    } else if (action === 'autorizar-edicion' || action === 'revocar-edicion') {
      if (item.estado_flujo !== 'publicada') throw new ReviewError('Solo se puede autorizar la edición de fichas publicadas.');
      if (action === 'autorizar-edicion') {
        await client.query('UPDATE investigaciones SET edicion_autorizada_at=now(),edicion_autorizada_por=$1,cambios_observaciones=NULL WHERE id=$2', [req.user.id, item.id]);
        result = 'edicion-autorizada';
      } else {
        await client.query(`UPDATE investigaciones SET edicion_autorizada_at=NULL,edicion_autorizada_por=NULL,cambios=NULL,cambios_imagen=NULL,
          cambios_estado=NULL,cambios_observaciones=NULL,cambios_enviados_at=NULL WHERE id=$1`, [item.id]);
        result = 'edicion-revocada';
      }
    } else if (action === 'aprobar-cambios') {
      if (item.estado_flujo !== 'publicada' || item.cambios_estado !== 'enviada' || !item.cambios) throw new ReviewError('Esta ficha no tiene cambios enviados para aprobar.');
      const c = item.cambios;
      // La versión nueva reemplaza la pública. Slug, territorio, fecha de publicación, visitas e inversiones no cambian.
      await client.query(`UPDATE investigaciones SET titulo=$1,subtitulo=$2,pregunta_gancho=$3,descripcion=$4,objetivo=$5,metodologia=$6,
          resultados=$7,estado_investigacion=$8,tipo=$9,imagen_credito=$10,sharepoint_url=$11,derechos_imagen_confirmados=$12,
          imagen=COALESCE(cambios_imagen,imagen),edicion_autorizada_at=NULL,edicion_autorizada_por=NULL,cambios=NULL,cambios_imagen=NULL,
          cambios_estado=NULL,cambios_observaciones=NULL,cambios_enviados_at=NULL,updated_at=now() WHERE id=$13`,
      [c.titulo, c.subtitulo, c.pregunta_gancho, c.descripcion, c.objetivo, c.metodologia, c.resultados, c.estado_investigacion,
        c.tipo, c.imagen_credito, c.sharepoint_url, c.derechos_imagen_confirmados === true, item.id]);
      await client.query('DELETE FROM investigadores WHERE investigacion_id=$1', [item.id]);
      for (const [index, name] of (c.investigadores || []).entries()) {
        await client.query('INSERT INTO investigadores(investigacion_id,nombre_completo,orden) VALUES($1,$2,$3)', [item.id, name, index]);
      }
      result = 'cambios-publicados';
    } else if (action === 'devolver-cambios') {
      if (item.estado_flujo !== 'publicada' || item.cambios_estado !== 'enviada') throw new ReviewError('Esta ficha no tiene cambios enviados para devolver.');
      const parsed = z.string().trim().min(10).max(1000).safeParse(req.body.observaciones);
      if (!parsed.success) throw new ReviewError('Escribe observaciones de entre 10 y 1000 caracteres para orientar al autor.', 400);
      await client.query("UPDATE investigaciones SET cambios_estado='devuelta',cambios_observaciones=$1 WHERE id=$2", [parsed.data, item.id]);
      result = 'cambios-devueltos';
    } else {
      if (!['seleccionada','publicada'].includes(item.estado_flujo)) throw new ReviewError('Solo se pueden archivar fichas seleccionadas o publicadas.');
      // Al archivar se descartan la autorización de edición y los cambios pendientes.
      await client.query(`UPDATE investigaciones SET estado_flujo='archivada',edicion_autorizada_at=NULL,edicion_autorizada_por=NULL,cambios=NULL,
        cambios_imagen=NULL,cambios_estado=NULL,cambios_observaciones=NULL,cambios_enviados_at=NULL,updated_at=now() WHERE id=$1`, [item.id]);
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
