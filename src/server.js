const app = require('./app');
const { ensureAdmin } = require('./seed-admin');
const port = Number(process.env.PORT) || 3000;

// En Render el arranque es `npm run migrate && npm start`: aquí se crea el admin inicial si aún no existe.
ensureAdmin()
  .then(({ created, skipped }) => {
    if (created) console.log('Cuenta de administración inicial creada.');
    if (skipped) console.warn(`Aviso: ${skipped}`);
  })
  .catch(error => console.error('No se pudo verificar la cuenta de administración:', error.message))
  .finally(() => app.listen(port, () => console.log(`POSTEA disponible en el puerto ${port}`)));
