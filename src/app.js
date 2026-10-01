const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const { pool } = require('./db');
const { router: accountRoutes, verifyCsrf, loadUser } = require('./account');
const researchRoutes = require('./research');
const reviewRoutes = require('./review');
const publicRoutes = require('./public');
const { router: interactionRoutes } = require('./interaction');
const moderationRoutes = require('./moderation');
const adminRoutes = require('./admin');
const rankingRoutes = require('./ranking');
const { router: printRoutes } = require('./print');

const app = express();
app.disable('x-powered-by');
if (process.env.NODE_ENV === 'production') app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(helmet({ contentSecurityPolicy: {
  directives: { ...helmet.contentSecurityPolicy.getDefaultDirectives(),
    'style-src': ["'self'", 'https://fonts.googleapis.com'],
    'font-src': ["'self'", 'https://fonts.gstatic.com'] }
} }));
app.use('/css', express.static(path.join(__dirname, '..', 'public', 'css'), { maxAge: '1d' }));
app.use('/js', express.static(path.join(__dirname, '..', 'public', 'js'), { maxAge: '1d' }));
app.use('/img', express.static(path.join(__dirname, '..', 'public', 'img'), { maxAge: '7d' }));

app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.type('text/plain').send('ok');
  } catch (error) {
    console.error('La base de datos no responde:', error.message);
    res.status(503).type('text/plain').send('La base de datos no está disponible');
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
app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).render('error', { title: 'Ocurrió un problema' });
});

module.exports = app;
