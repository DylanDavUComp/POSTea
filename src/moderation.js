const express = require('express');
const { pool } = require('./db');
const { requireRole, csrfToken } = require('./account');
const { loadConfig } = require('./config');
const { COMMENT_TYPES } = require('./interaction');
const router = express.Router();
const admin = requireRole('admin');

const SECTIONS = [
  ['pendiente', 'Por aprobar', 'Comentarios en espera porque la moderación previa está activa.'],
  ['reportado', 'Reportados', 'Salieron de la vista pública hasta que decidas.'],
  ['visible', 'Publicados recientes', 'Los últimos 50 comentarios visibles.'],
  ['oculto', 'Ocultos', 'Los últimos 50 comentarios ocultos.']
];

router.get('/admin/moderacion', admin, async (req, res) => {
  const [rows, config] = await Promise.all([
    pool.query(`SELECT * FROM (SELECT c.id,c.tipo,c.texto,c.estado,c.created_at,c.moderado_at,u.nombre,u.email,i.titulo,i.slug,
        (SELECT count(*)::int FROM reportes_comentario r WHERE r.comentario_id=c.id) AS reportes,
        row_number() OVER (PARTITION BY c.estado ORDER BY c.created_at DESC) AS n
      FROM comentarios c JOIN usuarios u ON u.id=c.usuario_id JOIN investigaciones i ON i.id=c.investigacion_id) x
      WHERE estado IN ('pendiente','reportado') OR n<=50 ORDER BY created_at DESC`),
    loadConfig()
  ]);
  const words = Array.isArray(config.palabras_bloqueadas) ? config.palabras_bloqueadas : [];
  res.render('admin-moderation', { title: 'Moderación · POSTEA', csrf: csrfToken(req), types: COMMENT_TYPES,
    sections: SECTIONS.map(([estado, heading, help]) => ({ estado, heading, help, items: rows.rows.filter(r => r.estado === estado) })),
    words, previa: config.moderacion_previa === true, resultado: String(req.query.resultado || '') });
});

router.post('/admin/moderacion/:id/:accion', admin, async (req, res) => {
  const target = { mostrar: 'visible', ocultar: 'oculto' }[req.params.accion];
  if (!target || !/^\d{1,18}$/.test(req.params.id)) return res.status(404).render('not-found', { title: 'Página no encontrada' });
  // moderado_at evita que un reporte posterior vuelva a ocultar un comentario ya aprobado.
  const result = await pool.query('UPDATE comentarios SET estado=$1,moderado_at=now(),moderado_por=$2 WHERE id=$3', [target, req.user.id, req.params.id]);
  if (!result.rowCount) return res.status(404).render('not-found', { title: 'Página no encontrada' });
  res.redirect(`/admin/moderacion?resultado=${target}#comentario-${req.params.id}`);
});

router.post('/admin/moderacion-ajustes', admin, async (req, res) => {
  const words = [...new Set(String(req.body.palabras || '').split(/[\n,]+/)
    .map(w => w.trim().toLowerCase()).filter(w => w && w.length <= 40))].slice(0, 500);
  await pool.query(`INSERT INTO configuracion(clave,valor) VALUES('palabras_bloqueadas',$1::jsonb),('moderacion_previa',$2::jsonb)
    ON CONFLICT (clave) DO UPDATE SET valor=EXCLUDED.valor`, [JSON.stringify(words), JSON.stringify(req.body.moderacion_previa === 'on')]);
  res.redirect('/admin/moderacion?resultado=ajustes');
});

module.exports = router;
