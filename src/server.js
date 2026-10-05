const app = require('./app');
const { ensureAdmin } = require('./seed-admin');
const port = Number(process.env.PORT) || 3000;
// 0.0.0.0 para que Render y Docker lleguen al proceso; HOST=127.0.0.1 lo deja solo en este equipo.
const host = process.env.HOST || '0.0.0.0';

// Node termina el proceso ante una promesa rechazada sin manejar; un corte de la base en una tarea de fondo
// (p. ej. la limpieza de sesiones) no debe tumbar la app. Se registra y se sigue atendiendo.
process.on('unhandledRejection', error => console.error('Promesa rechazada sin manejar:', error?.message || error));

// En el contenedor el arranque es `node scripts/migrate.js && node src/server.js`: aquí se crea el admin inicial si aún no existe.
ensureAdmin()
  .then(({ created, skipped }) => {
    if (created) console.log('Cuenta de administración inicial creada.');
    if (skipped) console.warn(`Aviso: ${skipped}`);
  })
  .catch(error => console.error('No se pudo verificar la cuenta de administración:', error.message))
  .finally(() => app.listen(port, host, () => console.log(`POSTEA disponible en http://${host}:${port}`)));
