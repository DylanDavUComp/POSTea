const express = require('express');
const { pool } = require('./db');
const { loadConfig, TZ } = require('./config');
const { publicName, COMMENT_TYPES } = require('./interaction');
const router = express.Router();

const ROTATION_SECONDS = 30;
const numeric = value => typeof value === 'string' && /^\d{1,18}$/.test(value) ? value : '';

async function ranking({ facultad = '', territorio = '', limit = 20 } = {}) {
  const values = [], where = ["i.estado_flujo='publicada'"];
  if (facultad) { values.push(facultad); where.push(`p.facultad_id=$${values.length}`); }
  if (territorio) { values.push(territorio); where.push(`i.territorio_id=$${values.length}`); }
  const base = `SELECT i.id,i.slug,i.titulo,i.pregunta_gancho,p.nombre AS programa,f.id AS facultad_id,f.nombre AS facultad,
      t.id AS territorio_id,t.nombre AS territorio,
      (SELECT coalesce(sum(monedas),0)::int FROM inversiones v WHERE v.investigacion_id=i.id) AS monedas,
      (SELECT count(DISTINCT usuario_id)::int FROM inversiones v WHERE v.investigacion_id=i.id) AS personas,
      (SELECT count(*)::int FROM comentarios c WHERE c.investigacion_id=i.id AND c.estado='visible') AS comentarios
    FROM investigaciones i JOIN programas p ON p.id=i.programa_id JOIN facultades f ON f.id=p.facultad_id
    JOIN territorios t ON t.id=i.territorio_id WHERE ${where.join(' AND ')}`;
  const [byCoins, byComments] = await Promise.all([
    pool.query(`SELECT * FROM (${base}) r WHERE monedas>0 ORDER BY monedas DESC,personas DESC,titulo LIMIT ${limit}`, values),
    pool.query(`SELECT * FROM (${base}) r WHERE comentarios>0 ORDER BY comentarios DESC,titulo LIMIT ${limit}`, values)
  ]);
  return { byCoins: byCoins.rows, byComments: byComments.rows };
}

router.get('/ranking', async (req, res) => {
  const config = await loadConfig();
  const allowed = config.mostrar_ranking_publico === true || req.user?.rol === 'admin';
  const filters = { facultad: numeric(req.query.facultad), territorio: numeric(req.query.territorio) };
  const [faculties, territories, lists] = await Promise.all([
    pool.query('SELECT id,nombre FROM facultades ORDER BY orden,nombre'),
    pool.query('SELECT id,nombre FROM territorios ORDER BY orden,nombre'),
    allowed ? ranking(filters) : null
  ]);
  res.set('Cache-Control', 'private, max-age=30');
  res.render('ranking', { title: 'Ranking · POSTEA', allowed, preview: allowed && config.mostrar_ranking_publico !== true,
    filters, faculties: faculties.rows, territories: territories.rows, lists, coinName: config.nombre_moneda || 'Imagos' });
});

// Pantalla del piso 10: se recarga sola cada 30 s (meta refresh, sin JavaScript) y rota un territorio por recarga.
router.get('/pantalla', async (req, res) => {
  const config = await loadConfig();
  const showRanking = config.mostrar_ranking_publico === true;
  const territories = (await pool.query(`SELECT t.id,t.nombre,t.color_hex FROM territorios t
    WHERE EXISTS (SELECT 1 FROM investigaciones i WHERE i.territorio_id=t.id AND i.estado_flujo='publicada') ORDER BY t.orden,t.nombre`)).rows;
  const current = territories.length ? territories[Math.floor(Date.now() / 1000 / ROTATION_SECONDS) % territories.length] : null;
  const [stats, comments, overall, featured] = await Promise.all([
    pool.query(`SELECT (SELECT count(*)::int FROM visitas) AS visitas,
        (SELECT count(*)::int FROM visitas WHERE (created_at AT TIME ZONE '${TZ}')::date=(now() AT TIME ZONE '${TZ}')::date) AS visitas_hoy,
        (SELECT count(*)::int FROM visitas WHERE origen='qr') AS escaneos,
        (SELECT count(*)::int FROM usuarios) AS registrados,
        (SELECT coalesce(sum(monedas),0)::int FROM inversiones) AS monedas,
        (SELECT count(*)::int FROM comentarios WHERE estado='visible') AS comentarios,
        (SELECT count(*)::int FROM investigaciones WHERE estado_flujo='publicada') AS publicadas`),
    pool.query(`SELECT c.tipo,c.texto,c.created_at,u.nombre,i.titulo FROM comentarios c JOIN usuarios u ON u.id=c.usuario_id
      JOIN investigaciones i ON i.id=c.investigacion_id WHERE c.estado='visible' AND i.estado_flujo='publicada' ORDER BY c.created_at DESC LIMIT 4`),
    showRanking ? ranking({ limit: 5 }) : null,
    current ? pool.query(`SELECT i.titulo,i.pregunta_gancho,p.nombre AS programa,f.nombre AS facultad,
        (SELECT coalesce(sum(monedas),0)::int FROM inversiones v WHERE v.investigacion_id=i.id) AS monedas
      FROM investigaciones i JOIN programas p ON p.id=i.programa_id JOIN facultades f ON f.id=p.facultad_id
      WHERE i.estado_flujo='publicada' AND i.territorio_id=$1 ORDER BY ${showRanking ? 'monedas DESC,' : ''}i.publicada_at DESC LIMIT 4`, [current.id]) : null
  ]);
  res.set('Cache-Control', 'no-store');
  res.render('screen', { title: 'POSTEA en vivo', refresh: ROTATION_SECONDS, stats: stats.rows[0], showRanking,
    comments: comments.rows.map(c => ({ ...c, autor: publicName(c.nombre), tipoNombre: COMMENT_TYPES[c.tipo] })),
    overall, current, featured: featured ? featured.rows : [], coinName: config.nombre_moneda || 'Imagos' });
});

module.exports = router;
