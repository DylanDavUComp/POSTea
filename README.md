# POSTEA. / tu ARTículo

Aplicación web del **Observatorio IMAGO** (Fundación Universitaria Compensar) para la **Semana de Innovación y Emprendimiento 2026**. Cada investigación se imprime como un post estilo Instagram con un QR. El QR abre su ficha web (`/f/:slug`), donde cualquiera lee sin registrarse, y quien se registra puede invertir monedas simbólicas o comentar.

- Especificación: [POSTEA_especificacion.md](POSTEA_especificacion.md)
- Estado por fase y cómo probar: [PROGRESO.md](PROGRESO.md)
- Decisiones técnicas: [DECISIONES.md](DECISIONES.md)

Stack: Node.js 24 LTS (compatible con 20.9+), Express 5, EJS renderizado en servidor, CSS propio, PostgreSQL (`pg`), sesiones en PostgreSQL, imágenes WebP guardadas en la base y QR generados al vuelo. Sin almacenamiento en disco ni servicios de pago.

---

## 1. Desarrollo local

Requisitos: Node.js 20.9 o superior (se probó con 24) y Docker Desktop (o Docker Engine con Compose v2).

El PostgreSQL de desarrollo es propio del proyecto: lo levanta [compose.yml](compose.yml) (PostgreSQL 16, base/usuario/contraseña `postea`) en el puerto **15432** del equipo, para no chocar con otros proyectos que usan 5432. Los datos persisten en un volumen de Docker.

En un PC nuevo (PowerShell):

```powershell
git clone <repo>
cd POSTea
npm ci                        # instala exactamente las versiones de package-lock.json
Copy-Item .env.example .env   # ajusta SESSION_SECRET, ADMIN_EMAIL, ADMIN_PASSWORD (12+ caracteres); DATABASE_URL ya apunta a 127.0.0.1:15432
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # genera un SESSION_SECRET para pegar en .env
npm run db:up                 # levanta PostgreSQL y espera a que esté healthy
npm run migrate               # aplica solo migraciones nuevas (tabla schema_migrations)
npm run dev                   # recarga al cambiar el código; crea el admin si no existe. http://localhost:3000
```

En bash usa `cp .env.example .env`. `npm start` arranca sin recarga. `GET /health` responde `ok` mientras el proceso atienda (liveness); `GET /health/db` responde `ok` solo si la base responde.

Base local:

```sh
npm run db:ps      # estado del contenedor (debe decir "healthy")
npm run db:logs    # logs de PostgreSQL (Ctrl+C para salir)
npm run db:down    # apaga PostgreSQL; los datos se conservan en el volumen
```

Para borrar **todos los datos locales** y empezar de cero: `docker compose down -v`, luego `npm run db:up` y `npm run migrate`. No afecta a Render.

En producción la app no asume host ni puerto: escucha en `0.0.0.0:$PORT` y usa solo la `DATABASE_URL` que entrega Render, con SSL cuando `NODE_ENV=production` (o según `DB_SSL` / `?sslmode=`).

Para probar la app en contenedor, como en Render: `docker compose --profile app up --build` (http://localhost:3000; usa tu `.env` y el PostgreSQL de compose).

### Datos de demostración (solo desarrollo)

La semilla base solo trae las 3 facultades, los 5 territorios y el admin. **No se inventan programas ni investigaciones.** Para probar:

```sh
npm run seed:demo                        # programa y autor "DEMO" y convocatoria abierta en tu base local
npm run demo:exhibicion                  # abre la exhibición desde hoy por 14 días (inversión y comentarios)
npm run demo:exhibicion -- --restaurar   # vuelve a las fechas oficiales
```

Ambos scripts se niegan a correr con `NODE_ENV=production`. El autor DEMO es `autor.demo@example.com`, con la contraseña `DEMO_AUTHOR_PASSWORD` de `.env`.

### Pruebas

```sh
npm test    # todas: migraciones, navegación y fases 3 a 8
```

Cada prueba crea sus datos temporales, restaura la configuración y los elimina al terminar. Entre ellas están las que pide la especificación: **inversiones simultáneas nunca dejan saldo negativo** (fase 6) y **no se puede seleccionar una cuarta investigación por programa** (fase 4). La fase 8 decodifica los QR con un lector real.

---

## 2. Uso por rol

| Rol | Dónde | Qué hace |
|---|---|---|
| Visitante | `/muro`, `/f/:slug`, `/mi-cuenta` | Explora, invierte sus Imagos, comenta, reporta comentarios y ve su historial. |
| Autor | `/panel` | Crea y edita fichas en la convocatoria, ve la vista previa del post, la ficha y la pieza imprimible, y descarga su QR. |
| Coordinador | `/coordinacion` | Activa autores pendientes de su programa (las cuentas nuevas ya quedan activas), selecciona hasta 3 fichas o las devuelve con observaciones, y prueba y verifica el QR. |
| Admin IMAGO | **Admin IMAGO** (`/admin`) | Tablero, **aprobar y publicar en un paso** (con territorio), autorizar la edición de fichas publicadas y aprobar sus cambios, moderación, programas (importación CSV), territorios, usuarios, impresión, configuración y exportar. |

Páginas del evento: `/ranking` (si se activa "Ranking público") y `/pantalla` (televisor del evento, en pantalla completa con F11; se recarga cada 30 s).

**Imprimir:** Admin IMAGO → Impresión → Pieza (o lote) → *Imprimir / Guardar como PDF*, con márgenes *Ninguno*, escala *100 %* y *Gráficos de fondo*. Sale a 50 × 70 cm. Mientras la URL no esté confirmada, todo lleva la marca **QR PROVISIONAL – NO IMPRIMIR**. Haz una prueba de impresión real (QR de 8 cm escaneado desde 1 m) antes de producir todas las piezas.

---

## 3. Despliegue en Render (Blueprint)

El repositorio incluye [render.yaml](render.yaml): servicio web `postea-imago` (**runtime Docker**, construido desde el [Dockerfile](Dockerfile)) y base `postea-db`, ambos **gratuitos** y en la **misma región** (Virginia). El contenedor aplica las migraciones y arranca (`node scripts/migrate.js && node src/server.js`) en `0.0.0.0:$PORT`. También define `healthCheckPath: /health`, `NODE_ENV=production`, `TZ=America/Bogota` y un `SESSION_SECRET` generado.

**Guía completa de variables, migración de datos (`pg_dump`/`pg_restore`), respaldos y lista de verificación: [DEPLOY_RENDER.md](DEPLOY_RENDER.md).**

### ⚠️ Antes de empezar: la base gratuita vence a los 30 días

PostgreSQL Free de Render **vence 30 días después de creada** y no tiene respaldos. Según su documentación, luego queda un periodo corto para pasarla a un plan de pago antes de eliminarla; verifica las condiciones vigentes. La convocatoria abre el **6 de octubre** y la exhibición cierra el **30 de octubre**; con 3 días de margen para exportar, la base debe durar hasta el 2 de noviembre:

| Si creas el Blueprint el… | La base vence el… | ¿Sirve? |
|---|---|---|
| **6 oct (día de apertura)** | **5 nov** | ✅ Cubre el evento y el margen para exportar |
| 7 oct | 6 nov | ⚠️ Sirve, pero la convocatoria ya abrió sin la app en línea |
| 3 oct o antes | 2 nov o antes | ⚠️ Margen para exportar de 3 días o menos |

Los programas oficiales se cargan solos al desplegar (migración 007). Detalle y avisos del tablero en [DEPLOY_RENDER.md](DEPLOY_RENDER.md#6-vida-de-la-base-gratuita).

### Pasos

1. Sube este código a un repositorio de GitHub o GitLab. El `.gitignore` ya excluye `.env`, `node_modules` y los logs; **nunca subas `.env`**.
2. En Render: **New → Blueprint**, conecta el repositorio y confirma. Render te pedirá los valores que el Blueprint no define:
   - `BASE_URL`: `https://postea-imago.onrender.com`, sin `/` final. Si Render asigna otro nombre por estar ocupado, usa la URL que te muestre. **Define a dónde apuntan los QR.**
   - `ADMIN_EMAIL` y `ADMIN_PASSWORD`, con al menos 12 caracteres. El admin se crea al primer arranque.
   - `ALLOWED_EMAIL_DOMAINS`: opcional, por ejemplo `ucompensar.edu.co`. Los autores deberán usar ese dominio.
3. Espera a que el despliegue termine y abre `https://…onrender.com/health/db`: debe decir `ok`. Luego revisa en Admin → Tablero el panel "Base de datos en Render" y el diagnóstico del proxy ([DEPLOY_RENDER.md](DEPLOY_RENDER.md)).
4. Ingresa como admin y, en este orden:
   1. **Cambia la contraseña inicial:** en Usuarios, genera un enlace de restablecimiento para tu propia cuenta, ábrelo y define una nueva. Después puedes borrar `ADMIN_PASSWORD` en Render → Environment.
   2. **Programas → Importar CSV** con la lista oficial (`nombre,facultad,es_especializacion`).
   3. **Usuarios:** asigna el rol coordinador y sus programas.
   4. **Configuración:** revisa fechas y funciones.
   5. Cuando la URL sea la definitiva, **Configuración → URL de los QR → Confirmar** (después de imprimir, esa URL y los slugs no deben cambiar).
5. Revisa el texto de `/privacidad`: es una versión de pruebas y requiere aprobación institucional (Ley 1581 de 2012).

Verificado en un ensayo local que replica Render: Linux con Node 24, `npm ci` en producción, PostgreSQL 16 con SSL, migraciones desde cero, admin creado al arrancar, conexiones TLS 1.3, cookie `Secure` detrás de HTTPS, `sharp` y `bcrypt` en Linux, registro con retorno a la ficha, QR, pieza y exportación. El despliegue real en tu cuenta de Render sigue pendiente.

### Durante la exhibición (27 al 30 de octubre)

- **Evitar que el servicio se duerma:** el plan gratuito se suspende tras unos 15 minutos sin tráfico y tarda cerca de un minuto en despertar. Configura un monitor gratuito externo (UptimeRobot, cron-job.org o similar) que consulte `https://…onrender.com/health` **cada 10 minutos**, desde el 26 hasta el 30 de octubre, en el horario en que `/pantalla` no esté abierta (la pantalla ya mantiene el servicio despierto). Las 750 horas gratuitas son por workspace: con otros servicios Free en el mismo workspace pueden no alcanzar. Detalle en [DEPLOY_RENDER.md](DEPLOY_RENDER.md#5-mantener-despierto-el-servicio).
- **Respaldos:** descarga **Admin IMAGO → Exportar → Descargar todo (ZIP)** al menos una vez al día, y un `pg_dump` con `bash scripts/backup-render.sh` al terminar el evento ([DEPLOY_RENDER.md](DEPLOY_RENDER.md#7-respaldos)).
- **Televisor:** abre `/pantalla` en pantalla completa. Activa "Ranking público" en Configuración si quieres mostrar el ranking.

---

## 4. Respaldos y restauración

- **Desde el panel:** Admin IMAGO → Exportar. Incluye CSV por tabla, respaldo JSON completo con imágenes y un ZIP con todo.
- **Copia completa restaurable con `pg_dump`:** en Render → postea-db → Networking, agrega tu IP a la lista de acceso. Copia la *External Database URL* y ejecuta:

```sh
pg_dump "$DATABASE_URL" > respaldo.sql          # bash
pg_dump $env:DATABASE_URL > respaldo.sql         # PowerShell
psql "$NUEVA_DATABASE_URL" < respaldo.sql        # restaurar en otra base
```

Quita tu IP de la lista al terminar.

---

## 5. Seguridad (resumen de la revisión final)

- Contraseñas con bcrypt (costo 12). El ingreso tarda lo mismo exista o no el correo.
- Sesiones en PostgreSQL con cookie `HttpOnly`, `SameSite=Lax` y `Secure` en producción. La sesión se regenera al ingresar.
- Token CSRF en todos los formularios POST.
- Límites de frecuencia en ingreso, registro, inversión, comentarios, reportes y restablecimiento. Se cuentan por cuenta cuando aplica, porque muchas personas comparten la wifi del campus.
- `helmet`: CSP sin scripts ni estilos en línea, HSTS, `nosniff`, `X-Frame-Options`, `Referrer-Policy: no-referrer`. Sin `X-Powered-By`.
- Consultas parametrizadas y validación con `zod`. Plantillas con escape automático; los únicos `<%-` son constantes o el SVG del QR generado por la librería.
- Imágenes: máximo 10 MB y aviso de nitidez en el formulario según los ppp en el área del póster (borrosa bajo 150, ≈ 2953 × 2776 px; suave de 150 a 200; nunca bloquea), guardadas hasta 200 ppp, formato verificado con `sharp`, recodificadas a WebP y privadas hasta su publicación. `sharp` 0.35.5 corrige vulnerabilidades de libvips. `npm audit`: 0 vulnerabilidades.
- Enlaces de restablecimiento de un solo uso, guardados como hash y válidos por 72 h. Usarlo cierra las sesiones abiertas.
- CSV exportados con protección contra inyección de fórmulas. Nunca se exportan contraseñas.
- Redirecciones `?next=` limitadas al propio sitio.

---

## 6. Variables de entorno

Ver [.env.example](.env.example).

| Variable | Uso |
|---|---|
| `DATABASE_URL` | Conexión PostgreSQL. En Render la enlaza el Blueprint (conexión interna). SSL automático en producción. |
| `DB_SSL`, `DB_SSL_REJECT_UNAUTHORIZED` | Opcionales. `DB_SSL=true/false` fuerza el SSL; si no, se usa `?sslmode=` de la URL o, sin él, `NODE_ENV`. |
| `DB_POOL_MAX` | Opcional. Conexiones del pool (5 por defecto, tope 20). |
| `HOST` | Opcional. Interfaz de escucha, `0.0.0.0` por defecto. |
| `CLIENT_IP_HEADER`, `TRUST_PROXY` | IP real del visitante tras el proxy. En Render: `cf-connecting-ip` y `trust proxy` 1 (por defecto en producción). Ver [DEPLOY_RENDER.md](DEPLOY_RENDER.md#3-proxy-de-render-e-ip-real). |
| `DB_EXPIRA_EN` | Fecha de vencimiento de la base Free (AAAA-MM-DD). El tablero muestra los días que faltan. |
| `DB_LIMITE_MB`, `DB_MARGEN_EXPORTAR_DIAS` | Opcionales (1024 y 3): alertas de tamaño y de vencimiento del tablero. |
| `DB_CONNECT_RETRIES`, `DB_RETRY_BASE_MS` | Opcionales (10 y 1000): reintentos de las migraciones si la base aún no responde. |
| `SESSION_SECRET` | Mínimo 32 caracteres. El Blueprint lo genera. |
| `BASE_URL` | URL pública sin `/` final. Define los QR. |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | Crean el admin inicial si no existe (contraseña de 12 caracteres o más). Nunca cambian una cuenta existente. |
| `ALLOWED_EMAIL_DOMAINS` | Opcional. Dominios permitidos para autores, separados por comas. |
| `VISITOR_DOMAIN_RESTRICTED` | `true` aplica esos dominios también a visitantes. |
| `NODE_ENV`, `TZ`, `PORT` | `production`, `America/Bogota`; Render define `PORT`. |
| `DEMO_AUTHOR_PASSWORD` | Solo desarrollo, para `npm run seed:demo`. |
