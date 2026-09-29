require('dotenv').config({ quiet: true });
const { pool } = require('../src/db');
const { ensureAdmin } = require('../src/seed-admin');

ensureAdmin({ required: true })
  .then(({ created }) => console.log(created ? 'Cuenta de administración creada.' : 'La cuenta de administración ya existe; no se cambió su contraseña.'))
  .catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(() => pool.end());
