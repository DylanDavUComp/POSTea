const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const { pool, isDbUnavailable } = require('./db');
const { router: accountRoutes, verifyCsrf, loadUser } = require('./account');
const researchRoutes = require('./research');
const reviewRoutes = require('./review');
const publicRoutes = require('./public');
const { router: interactionRoutes } = require('./interaction');
const moderationRoutes = require('./moderation');
const adminRoutes = require('./admin');
const rankingRoutes = require('./ranking');
const { router: printRoutes } = require('./print');
const { trustProxySetting } = require('./client-ip');

const app = express();
app.disable('x-powered-by');
// Detrás del proxy HTTPS de Render: sin esto req.secure es false y express-session no envía la cookie `Secure`
// (nadie podría ingresar). La IP de cada visitante se obtiene con clientIp (src/client-ip.js).
app.set('trust proxy', trustProxySetting());
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(helmet({ contentSecurityPolicy: {
  directives: { ...helmet.contentSecurityPolicy.getDefaultDirectives(),
    'style-src': ["'self'", 'https://fonts.googleapis.com'],
    'font-src': ["'self'", 'https://fonts.gstatic.com'] }
} }));
// gzip para HTML, CSS, JS y SVG (5 GB/mes de salida en el plan gratuito). Las imágenes WebP ya vienen comprimidas.
// Las exportaciones se excluyen: van por partes con control de contrapresión propio y las descarga solo el admin.
app.use(compression({ threshold: 1024, filter: (req, res) => !/^\/admin\/(exportar|impresion\/qr\.zip)/.test(req.path) && compression.filter(req, res) }));
app.use('/css', express.static(path.join(__dirname, '..', 'public', 'css'), { maxAge: '1d' }));
app.use('/js', express.static(path.join(__dirname, '..', 'public', 'js'), { maxAge: '1d' }));
app.use('/img', express.static(path.join(__dirname, '..', 'public', 'img'), { maxAge: '7d' }));

// Liveness (healthCheckPath de Render): 200 mientras el proceso atienda, aunque la base esté caída.
// Render deja de enrutar tras 15 s de fallos y reinicia a los 60 s. Si /health dependiera de la base, un mantenimiento
// de unos minutos provocaría reinicios en bucle: cada arranque espera a la base para migrar y no escucha mientras tanto.
// La base se verifica antes de escuchar (el CMD migra primero), así que un despliegue sin base igual falla.
app.get('/health', (_req, res) => res.set('Cache-Control', 'no-store').type('text/plain').send('ok'));
// Readiness con base: para el monitor externo y para diagnosticar. 503 si la base no responde.
app.get('/health/db', async (_req, res) => {
  res.set('Cache-Control', 'no-store').type('text/plain');
  try {
    await pool.query('SELECT 1');
    res.send('ok');
  } catch (error) {
    console.error('La base de datos no responde:', error.message);
    res.status(503).send('La base de datos no está disponible');
  }
});

if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
  throw new Error('SESSION_SECRET debe tener al menos 32 caracteres.');
}
// Formularios pequeños en general; solo la importación CSV de programas admite un cuerpo mayor.
const smallForm = express.urlencoded({ extended: false, limit: '16kb' });
const csvForm = express.urlencoded({ extended: false, limit: '256kb' });
app.use((req, res, next) => (req.path === '/admin/programas-importar' ? csvForm : smallForm)(req, res, next));
app.use(session({
  store: new PgSession({ pool, tableName: 'sesiones', createTableIfMissing: false }),
  name: 'postea.sid', secret: process.env.SESSION_SECRET,
  resave: false, saveUninitialized: false, rolling: true,
  cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 30 * 24 * 60 * 60 * 1000 }
}));
// express-session guarda al terminar la respuesta, pero el navegador puede seguir la redirección antes de que
// termine ese guardado y leer la sesión vieja (se perderían avisos y datos recién escritos). Guardamos primero.
app.use((req, res, next) => {
  const redirect = res.redirect.bind(res);
  // Solo sesiones con datos: una sesión anónima vacía no se guarda (saveUninitialized: false).
  const hasData = () => req.session && Object.keys(req.session).some(key => key !== 'cookie');
  res.redirect = (...args) => hasData() ? req.session.save(error => error ? next(error) : redirect(...args)) : redirect(...args);
  next();
});
app.use(loadUser);
app.use((req, res, next) => {
  if (req.method !== 'POST') return next();
  if (req.is('multipart/form-data')) {
    if (/^\/panel\/investigaciones\/(nueva|\d+\/editar)$/.test(req.path)) return next();
    return res.status(415).render('error', { title: 'Formulario no admitido', message: 'Usa el formulario de la página.' });
  }
  // Sin sesión activa no hay nada que cerrar: no mostrar "Formulario vencido" por un token viejo.
  if (req.path === '/salir' && !req.session.userId) return res.redirect('/?salida=1');
  // Sesión vencida mientras leía la ficha: volver a ingresar y regresar al mismo bloque, sin error.
  const action = req.path.match(/^\/f\/([^/]{1,180})\/(invertir|comentar)$/);
  if (action && !req.session.userId) {
    return res.redirect(`/ingresar?next=${encodeURIComponent(`/f/${action[1]}#${action[2] === 'invertir' ? 'invierte' : 'comenta'}`)}`);
  }
  return verifyCsrf(req, res, next);
});
app.use(accountRoutes);
app.use(researchRoutes);
// Antes de reviewRoutes: /coordinacion/investigaciones/:id/verificar-qr no debe caer en /:id/:accion.
app.use(printRoutes);
app.use(reviewRoutes);
app.use(publicRoutes);
app.use(interactionRoutes);
app.use(moderationRoutes);
app.use(adminRoutes);
app.use(rankingRoutes);

app.use((_req, res) => res.status(404).render('not-found', { title: 'Página no encontrada' }));
app.use((error, _req, res, next) => {
  if (res.headersSent) return next(error);
  // Base caída en caliente (mantenimiento de Render): 503 amable y la app sigue viva; se recupera sola al volver la base.
  if (isDbUnavailable(error)) {
    console.error('Base no disponible:', error.code || error.message);
    return res.status(503).set('Retry-After', '30').render('error', { title: 'Volvemos en un momento',
      message: 'Estamos teniendo una interrupción breve. Espera un minuto y vuelve a cargar la página; lo que ya registraste está a salvo.' });
  }
  console.error(error);
  res.status(500).render('error', { title: 'Ocurrió un problema' });
});

module.exports = app;
