const express = require('express');
const crypto = require('node:crypto');
const { pool } = require('./db');
const { loadConfig, schedule, participation } = require('./config');
const { fichePanel } = require('./interaction');
const router = express.Router();
const fields = `i.id,i.slug,i.titulo,i.pregunta_gancho,i.estado_investigacion,i.programa_id,i.territorio_id,
  p.nombre AS programa,f.id AS facultad_id,f.nombre AS facultad,t.nombre AS territorio`;
const joins = `FROM investigaciones i JOIN programas p ON p.id=i.programa_id
  JOIN facultades f ON f.id=p.facultad_id JOIN territorios t ON t.id=i.territorio_id`;

router.get('/', async (req, res) => {
  const config = await loadConfig();
  res.render('home', { title: 'POSTEA. / tu ARTículo', milestones: schedule(config).milestones,
    farewell: req.query.salida === '1' && !req.user });
});

// Colores editables por el admin: la CSP no admite estilos en línea, así que se sirven como hoja propia.
router.get('/css/catalogos.css', async (_req, res) => {
  const [faculties, territories] = await Promise.all([
    pool.query('SELECT id,color_hex FROM facultades'), pool.query('SELECT id,color_hex FROM territorios')]);
  const css = [...faculties.rows.map(r => `.fac-${r.id}{--fac:${r.color_hex}}`),
    ...territories.rows.map(r => `.ter-${r.id}{--ter:${r.color_hex}}`)].join('\n');
  res.set('Cache-Control', 'public, max-age=300').type('text/css').send(css);
});

router.get('/muro', async (req, res) => {
  const filters = {};
  for (const key of ['facultad','programa','territorio']) filters[key] = typeof req.query[key] === 'string' && /^\d{1,18}$/.test(req.query[key]) ? req.query[key] : '';
  filters.estado = ['terminada','en_desarrollo'].includes(req.query.estado) ? req.query.estado : '';
  filters.q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0,100) : '';
  const values = [], conditions = ["i.estado_flujo='publicada'"];
  for (const [key,column] of [['facultad','f.id'],['programa','p.id'],['territorio','t.id'],['estado','i.estado_investigacion']]) {
    if (filters[key]) { values.push(filters[key]); conditions.push(`${column}=$${values.length}`); }
  }
  if (filters.q) {
    values.push(filters.q);
    conditions.push(`strpos(lower(concat_ws(' ',i.titulo,i.pregunta_gancho,i.descripcion,p.nombre,
      (SELECT string_agg(nombre_completo,' ') FROM investigadores WHERE investigacion_id=i.id))),lower($${values.length}))>0`);
  }
  const [items,faculties,programs,territories] = await Promise.all([
    pool.query(`SELECT ${fields} ${joins} WHERE ${conditions.join(' AND ')} ORDER BY t.orden,t.nombre,i.publicada_at DESC,i.id`,values),
    pool.query('SELECT id,nombre FROM facultades ORDER BY orden,nombre'),
    pool.query(`SELECT DISTINCT p.id,p.nombre FROM programas p JOIN investigaciones i ON i.programa_id=p.id WHERE i.estado_flujo='publicada' ORDER BY p.nombre`),
    pool.query('SELECT id,nombre FROM territorios ORDER BY orden,nombre')
  ]);
  res.render('wall', { title:'Explora las investigaciones · POSTEA', items:items.rows, faculties:faculties.rows, programs:programs.rows, territories:territories.rows, filters });
});

async function recordVisit(req, id) {
  // HMAC evita guardar IP o agente en claro. Usuarios autenticados se deduplican también entre dispositivos.
  const agent = crypto.createHmac('sha256',process.env.SESSION_SECRET)
    .update(`${req.ip}\n${(req.get('user-agent') || '').slice(0,1000)}`).digest('hex');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)',[id]);
    await client.query(`INSERT INTO visitas(investigacion_id,usuario_id,origen,user_agent_hash)
      SELECT $1,$2,$3,$4 WHERE EXISTS (SELECT 1 FROM investigaciones WHERE id=$1 AND estado_flujo='publicada')
      AND NOT EXISTS (SELECT 1 FROM visitas WHERE investigacion_id=$1 AND created_at>now()-interval '30 minutes'
        AND (user_agent_hash=$4 OR ($2::bigint IS NOT NULL AND usuario_id=$2)))`,
    [id,req.user?.id || null,req.query.src === 'qr' ? 'qr' : 'web',agent]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

router.get('/f/:slug', async (req,res) => {
  if (req.params.slug.length > 180) return res.status(404).render('not-found',{title:'Ficha no encontrada'});
  const item = (await pool.query(`SELECT ${fields},i.subtitulo,i.descripcion,i.objetivo,i.metodologia,i.resultados,i.imagen_credito,i.sharepoint_url,i.autor_id
    ${joins} WHERE i.slug=$1 AND i.estado_flujo='publicada'`,[req.params.slug])).rows[0];
  if (!item) return res.status(404).render('not-found',{title:'Ficha no encontrada'});
  const [researchers,related,config] = await Promise.all([
    pool.query('SELECT nombre_completo FROM investigadores WHERE investigacion_id=$1 ORDER BY orden,id',[item.id]),
    pool.query(`SELECT ${fields} ${joins} WHERE i.estado_flujo='publicada' AND i.territorio_id=$1 AND i.id<>$2
      ORDER BY (f.id<>$3) DESC,i.publicada_at DESC,i.id LIMIT 3`,[item.territorio_id,item.id,item.facultad_id]),
    loadConfig()
  ]);
  // HEAD y prefetch no representan una apertura de la ficha.
  if (req.method === 'GET' && !/prefetch/i.test(`${req.get('purpose') || ''} ${req.get('sec-purpose') || ''}`)) await recordVisit(req,item.id);
  const panel = await fichePanel(item, req.user, config);
  // El aviso de la última acción se muestra una sola vez (patrón POST → redirección → GET).
  const flash = req.session?.flash || null;
  if (flash) delete req.session.flash;
  const confirmCoins = /^\d{1,6}$/.test(String(req.query.confirmar || '')) ? Number(req.query.confirmar) : null;
  res.set('Cache-Control','private, no-store');
  if (flash) await new Promise((resolve, reject) => req.session.save(error => error ? reject(error) : resolve()));
  res.render('public-research',{title:`${item.titulo} · POSTEA`,item,researchers:researchers.rows,related:related.rows,
    nextUrl:`/f/${item.slug}`,invest:participation(config,'inversion_activa','La inversión'),
    comment:participation(config,'comentarios_activos','El espacio de comentarios'),
    showTotals: config.inversion_activa === true && (schedule(config).exhibition.active || schedule(config).exhibition.ended),
    panel, flash, confirmCoins, presetType: panel.commentTypes[req.query.tipo] ? req.query.tipo : ''});
});
module.exports = router;
