# Despliegue en Render (plan gratuito, runtime Docker)

POSTEA se despliega como **Web Service** de Render construido desde el [Dockerfile](Dockerfile), con una base **PostgreSQL administrada por Render**. Render no usa `compose.yml`.

Límites del plan que condicionan todo lo de abajo:
- **Web Service Free:** 512 MB de RAM, 0,1 CPU compartida y disco efímero. Se duerme tras 15 min sin tráfico. Hay 750 horas de instancia por mes **para todo el workspace**.
- **Postgres Free:** 1 GB, sin respaldos y con mantenimientos sin aviso. **Vence 30 días después de creada**; luego hay 14 días de gracia para pasarla a un plan de pago antes de que la borren.

Resumen técnico:
- **Arranque:** el `CMD` del Dockerfile ejecuta `node scripts/migrate.js && exec node src/server.js`. En Render deja **Docker Command vacío**.
  - Las migraciones son idempotentes: usan la tabla `schema_migrations` y un *advisory lock* dentro de una transacción.
  - Si la base aún no responde, reintentan con espera progresiva: 1, 2, 4, 8, 16 y luego 30 s, hasta 10 intentos.
  - Después se crea el admin inicial si no existe.
- **Puerto:** la app escucha en `0.0.0.0:$PORT`. Render define `PORT`.
- **Health check (`healthCheckPath: /health`):** es *liveness*. Responde `200 ok` mientras el proceso atienda, **aunque la base esté caída**.
  - Render deja de enrutar tras 15 s de fallos y reinicia a los 60 s. Si `/health` dependiera de la base, un mantenimiento de unos minutos provocaría reinicios en bucle, porque cada arranque espera a la base para migrar.
  - La base sí se verifica antes de escuchar: un despliegue sin base nunca pasa a "Live".
  - **`/health/db`** es *readiness*: `200` si la base responde, `503` si no. Úsala para alertas.
- **Base caída en caliente:** las páginas responden **503** con "Volvemos en un momento" y `Retry-After: 30`. La app no se cae y se recupera sola cuando vuelve la base.

---

## 1. Crear los servicios

**Opción A, Blueprint (recomendada):** Render → **New → Blueprint** → elige el repositorio. [render.yaml](render.yaml) crea:
- `postea-imago`: Docker, free, Virginia.
- `postea-db`: PostgreSQL 16, free, Virginia.

Además enlaza `DATABASE_URL`, genera `SESSION_SECRET` y te pide los valores marcados `sync: false`.

**Opción B, manual:**
1. **New → Postgres**: nombre `postea-db`, base `postea`, usuario `postea`, PostgreSQL 16, región Virginia, plan Free.
2. **New → Web Service** → repositorio → *Language* **Docker**, región Virginia, plan Free.
   - *Dockerfile Path*: `./Dockerfile`.
   - *Docker Command*: vacío.
   - *Health Check Path*: `/health`.
3. Configura las variables de la sección 2.

## 2. Variables de entorno (Render → postea-imago → Environment)

| Variable | Valor | Notas |
|---|---|---|
| `DATABASE_URL` | **Internal Database URL** de `postea-db` | El Blueprint la enlaza solo. |
| `NODE_ENV` | `production` | Cookie `Secure`, `trust proxy` 1 y SSL hacia la base. |
| `TZ` | `America/Bogota` | Respaldo. Las reglas de fechas ya no dependen de la zona del servidor (sección 9). |
| `SESSION_SECRET` | Cadena aleatoria de 32+ caracteres | El Blueprint la genera (`generateValue`). |
| `BASE_URL` | URL pública **https**, sin `/` final | **Define a dónde apuntan los QR.** Ver sección 4. |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | Correo y contraseña de 12+ caracteres | Solo crean el admin si no existe. Borra `ADMIN_PASSWORD` tras el primer ingreso (sección 8). |
| `CLIENT_IP_HEADER` | `cf-connecting-ip` | IP real del visitante tras Cloudflare, para los límites y las visitas. Ya está en el Blueprint. |
| `DB_EXPIRA_EN` | Fecha `AAAA-MM-DD` de vencimiento de la base | La que muestra Render → postea-db. El tablero muestra los días que faltan (sección 6). |
| `ALLOWED_EMAIL_DOMAINS` | Opcional, p. ej. `ucompensar.edu.co` | |
| `VISITOR_DOMAIN_RESTRICTED` | `false` | |
| `TRUST_PROXY` | Vacío (1 en producción) | Solo si el diagnóstico del proxy indica otra cosa (sección 3). |
| `DB_SSL`, `DB_SSL_REJECT_UNAUTHORIZED`, `DB_POOL_MAX` | Vacíos | `DB_SSL=false` solo si los logs dicen *"The server does not support SSL connections"*. Pool: 5. |
| `DB_LIMITE_MB`, `DB_MARGEN_EXPORTAR_DIAS` | Vacíos (1024 y 3) | Límite de la base y margen para exportar, usados en las alertas del tablero. |
| `PORT`, `HOST` | **No configurar** | |

## 3. Proxy de Render e IP real

Render pasa cada solicitud por **Cloudflare** y por su balanceador. Eso tiene dos consecuencias:

1. **HTTPS.** Con `trust proxy` en 1, Express lee `X-Forwarded-Proto` del balanceador. Así `req.secure` es `true` y la cookie de sesión sale con `Secure`.
   - **Sin ese ajuste nadie podría ingresar:** express-session no envía una cookie `Secure` por una conexión que cree HTTP. Está comprobado en `tests/proxy-smoke.js`.
2. **IP del visitante.** `X-Forwarded-For` trae varios saltos y Render no limpia el valor que manda el cliente, así que el primero se puede falsificar. Con `trust proxy` 1, `req.ip` puede quedar con la IP de un proxy compartido por todos.
   - Por eso los límites (registro: 60 por IP cada 15 min; ingreso: 10 fallidos por IP y correo; restablecimiento) y el HMAC de visitas usan **`cf-connecting-ip`**. Cloudflare escribe esa cabecera en su borde y reemplaza cualquier valor que mande el cliente.

**Sin estos ajustes:**
- Todos los visitantes compartirían una sola IP. El límite de 60 registros cada 15 min sería para **todo el evento**: frente al vidrio, con cientos de personas, el registro se bloquearía.
- Las visitas de personas distintas con el mismo modelo de celular se contarían como una sola.

**Verificación después del primer despliegue:**
1. Entra a **Admin → Tablero → "Diagnóstico del proxy"** desde tu celular, con datos móviles.
2. "IP usada para límites y visitas" debe ser la IP pública de tu celular (compárala con un sitio tipo "cuál es mi IP"). "HTTPS detectado" debe decir **sí**.
3. Si la cabecera aparece "ausente", Render cambió su red. En ese caso:
   - borra `CLIENT_IP_HEADER`;
   - ajusta `TRUST_PROXY` al número de saltos que muestre el diagnóstico (la IP real debe quedar en `req.ip`).

## 4. URL pública, QR y dominio propio

- Los QR se generan al vuelo desde **`BASE_URL`** (variable de entorno). Nunca se guardan.
- Las piezas y descargas llevan la marca **«QR PROVISIONAL – NO IMPRIMIR»** mientras se cumpla cualquiera de estas condiciones:
  - `BASE_URL` está vacía, es `localhost` o no usa `https://`;
  - la URL no está confirmada en **Admin → Configuración → URL de los QR**;
  - **`BASE_URL` cambió después de confirmarla** (la confirmación guarda la URL exacta);
  - la ficha no está publicada.
- Un subdominio `onrender.com` sin confirmar también queda provisional. La página de configuración avisa que, si habrá dominio propio, hay que configurarlo **antes** de confirmar.

> ⚠️ **La URL debe ser definitiva ANTES de imprimir.** Después de imprimir, ni `BASE_URL` ni los slugs pueden cambiar: los QR pegados en los vidrios apuntarían a otra parte.

**Dominio propio (opcional, p. ej. `postea.ucompensar.edu.co`):**
1. Render → postea-imago → **Settings → Custom Domains → Add Custom Domain** → escribe el subdominio.
2. Render muestra el destino: un registro **CNAME** hacia `postea-imago.onrender.com` (usa el que muestre Render).
3. En el DNS de la institución (TI de UCompensar), crea `postea` → **CNAME** → `postea-imago.onrender.com`. Para un dominio raíz, sin subdominio, Render indica un registro A o ALIAS.
4. Espera a que Render marque el dominio como **Verified** y emita el certificado HTTPS. Suele tardar minutos; con DNS institucionales, a veces horas.
5. Cambia `BASE_URL` a `https://postea.ucompensar.edu.co` (Environment → Save; Render redespliega).
6. Abre `https://postea.ucompensar.edu.co/health`: debe decir `ok`. Luego **Admin → Configuración → Confirmar URL para impresión**.
7. La URL `onrender.com` sigue funcionando, pero los QR usarán solo `BASE_URL`.

## 5. Mantener despierto el servicio

El servicio Free **se duerme tras 15 min sin tráfico entrante** y tarda cerca de un minuto en despertar. Para alguien que acaba de escanear un QR, un minuto en blanco es abandonar.

- **Cuándo no hace falta:** mientras **`/pantalla`** esté abierta en el televisor. Se recarga cada 30 s y eso cuenta como tráfico.
- **Cuándo sí hace falta:**
  - en el horario de exhibición en que el televisor esté apagado o sin `/pantalla` (montaje, mañanas, fallas del TV);
  - en días de alta actividad de autores (cierre de convocatoria, 19 oct), si no quieres esperas.

**Configuración:**
- **cron-job.org (recomendado, permite horario):**
  1. *Create cronjob* → URL `https://<tu-dominio>/health`.
  2. *Every 10 minutes*.
  3. En *Advanced*, limita las horas, p. ej. 6:00 a 22:00, zona America/Bogota, del 26 al 30 de octubre.
  4. Activa la notificación si falla.
- **UptimeRobot:** *Add New Monitor* → HTTP(s) → URL `https://<tu-dominio>/health` → intervalo 10 min. Para alertas de base caída, agrega un segundo monitor a `/health/db`: avisa si devuelve 503.

**Horas de instancia:** 750 por mes **por workspace**. Un servicio encendido 24/7 en octubre (31 días) usa 744 h y cabe justo, **si no hay otros servicios Free en el mismo workspace**. Si se agotan, Render suspende los servicios Free hasta el mes siguiente. Por eso conviene limitar el ping a las horas y días del evento.

## 6. Vida de la base gratuita

- **Fechas:** con la configuración por defecto (exhibición hasta el 30 oct 23:59), desde la apertura de la convocatoria (6 oct) hasta el final de la exhibición más 3 días para exportar hay **28 días**.
- ⚠️ **Eso supera 25 días y queda a 2 días de los 30 de vida de la base.**
  - Si la base se crea **el 6 de octubre** (día de apertura), vence el **5 de noviembre**: cubre el evento y deja el margen justo.
  - Crearla después del 6 de octubre retrasa el despliegue con la convocatoria ya abierta.
  - Recrearla, por ejemplo para "empezar limpio", reinicia el reloj, pero exige restaurar los datos (sección 7).
- **Configura `DB_EXPIRA_EN`** con la fecha "Expires" de Render → postea-db. **Admin → Tablero → "Base de datos en Render"** muestra:
  - la fecha de expiración y los días que faltan. Cambia a naranja con menos de 7 días y a rojo con 2 o menos;
  - un aviso si la base vence antes del fin de la exhibición más el margen.
- **Exportación final:** entre el 31 de octubre y el 2 de noviembre, con `scripts/backup-render.sh` y **Admin → Exportar → Descargar todo (ZIP)**.

**Tamaño (límite 1 GB):** el tablero muestra `pg_database_size` y las 6 tablas más grandes, y alerta al pasar del 70 %. Medido con 450 fichas de carga:

| Dato | Tamaño |
|---|---|
| Ficha con imagen | ~1–2 MB (WebP de hasta ~4000 px, 200 ppp en el póster; desde el 09/10) + ~0,09 MB de su variante de 1080 px. Las subidas anteriores pesan ~0,36 MB (1600 px). Con 150 fichas: ~150–300 MB |
| Propuesta de cambios con imagen | +1–2 MB mientras está pendiente; se borra al aprobar o devolver |
| Visita | ~180 B por fila (120.000 visitas ≈ 21 MB) |

Con 150 fichas (38 con propuesta) y 30.000 visitas, la base midió 82 MB. El 70 % (717 MB) solo se alcanzaría con unas 1.600 fichas, unas 900 si todas tuvieran una propuesta con imagen pendiente, o con millones de visitas.

**Sesiones:** `connect-pg-simple` borra las expiradas cada 15 min. No hace falta limpieza adicional ni agregar las visitas.

## 7. Respaldos

La base Free **no tiene respaldos**. Tienes dos caminos.

### 7.1 `pg_dump` completo (restaurable) con `scripts/backup-render.sh`

Flujo con la lista de IP permitidas (`ipAllowList: []` deja la base cerrada):
1. Render → postea-db → **Networking → Access Control → Add source**: tu IP pública/32 (Render muestra "Add my IP").
2. Copia la **External Database URL** (Connect → External). No la guardes en archivos del repositorio.
3. Ejecuta desde Git Bash, en la carpeta del proyecto:
   ```bash
   bash scripts/backup-render.sh            # pide la URL sin mostrarla
   # o: RENDER_DATABASE_URL='postgres://…' bash scripts/backup-render.sh respaldos
   ```
   El script:
   - usa `pg_dump -Fc` (local o, si no hay, el contenedor `postgres:16.4-alpine`);
   - **verifica que `pg_dump` sea de la misma versión mayor que el servidor o más nueva**;
   - nombra el archivo `respaldos/render-AAAAMMDD-HHMMSS.dump`;
   - **comprueba que no esté vacío** y que `pg_restore --list` encuentre los datos de las tablas.
4. **Quita tu IP** de Access Control.

Para restaurar en otra base: ver la sección 10.2 (`pg_restore --no-owner --no-acl`).

### 7.2 Respaldo desde el panel (sin abrir la base)

**Admin IMAGO → Exportar.** No requiere tocar la red de la base:
- CSV por tabla;
- **respaldo JSON completo** con imágenes en base64 (imagen y propuesta);
- **ZIP** con los CSV, el JSON y cada imagen como archivo `.webp`.

Todo se genera **por partes**, con memoria estable: medido con 450 fichas en un contenedor de 512 MB, el pico fue de 164 MB. Antes se armaba entero en memoria y el contenedor moría por falta de memoria. Solo corre una exportación pesada a la vez; la segunda recibe "Exportación en curso". No es un `pg_dump`: sirve para conservar y analizar los datos, no para restaurar la base tal cual.

**Recomendado:** ZIP del panel a diario durante la exhibición y `pg_dump` al cerrar.

## 8. Producción segura

- [render.yaml](render.yaml):
  - `NODE_ENV=production`;
  - `SESSION_SECRET` con `generateValue`;
  - secretos (`BASE_URL`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ALLOWED_EMAIL_DOMAINS`, `DB_EXPIRA_EN`) con `sync: false`, sin valor en el archivo;
  - `plan: free` y `region: virginia` en web y base;
  - `healthCheckPath: /health`. `tests/phase9-smoke.js` lo verifica.
- **`autoDeploy`:** hoy está en `true`. **Recomendación:** pásalo a `false` (en `render.yaml` o en Settings → Auto-Deploy) desde el **20 de octubre** (inicio de Producción) hasta el cierre. Así un push accidental no redespliega en plena impresión o exhibición. Las correcciones se despliegan con **Manual Deploy**, después de `npm test`.
- `seed:demo` y `demo:exhibicion` **se niegan a correr con `NODE_ENV=production`** y además no van en la imagen (`.dockerignore`).
- **Cambiar la contraseña del admin y borrar `ADMIN_PASSWORD` tras el primer ingreso:**
  1. Ingresa con `ADMIN_EMAIL` / `ADMIN_PASSWORD`.
  2. **Admin → Usuarios** → tu cuenta → **Generar enlace de restablecimiento**.
  3. Abre el enlace (válido 72 h, un solo uso) y define una contraseña nueva. Se cierran las demás sesiones.
  4. Render → Environment → elimina **`ADMIN_PASSWORD`** → Save. El redespliegue no cambia la cuenta: el admin solo se crea si no existe.
  5. Ingresa de nuevo con la contraseña nueva para confirmar.

## 9. Fechas y zona horaria

Render corre en UTC. Las fechas de `configuracion` se guardan en ISO 8601 **con desfase explícito** (`2026-10-19T23:59:00-05:00`), así que son instantes absolutos: apertura, cierre, producción, exhibición, `inversion_activa` y el cronograma de la landing se comparan igual en cualquier zona.

- Una fecha sin hora se interpreta en Bogotá: inicio del día para aperturas y fin del día para cierres.
- Las consultas por día (tablero, "hoy" en `/pantalla`) usan `AT TIME ZONE 'America/Bogota'`.
- Las franjas de `/pantalla` rotan por tiempo absoluto, sin depender de la zona.
- `TZ=America/Bogota` queda en el Dockerfile y el Blueprint solo como respaldo.
- `tests/timezone-smoke.js` corre con `TZ=UTC` y verifica el cierre exacto: abierta a las 23:59:00.000 de Bogotá y cerrada 1 ms después.

## 10. Datos locales → Render

Usa contenedores `postgres:16.4-alpine` (misma versión mayor que Render). Los comandos son para PowerShell, desde la carpeta del proyecto. Primero abre el acceso como en la sección 7.1, pasos 1 y 2.

### 10.1 Exportar la base local
```powershell
New-Item -ItemType Directory -Force respaldos | Out-Null
docker compose exec -T db pg_dump -U postea -d postea -Fc --no-owner --no-acl -f /tmp/postea-local.dump
docker compose cp db:/tmp/postea-local.dump respaldos/postea-local.dump
```
> No uses `> archivo.dump` en PowerShell 5.1: corrompe los archivos binarios.

### 10.2 Restaurar en Render

La app migra al primer arranque, así que la base de Render ya tendrá el esquema, los catálogos y el admin.

1. Render → postea-imago → **Suspend**.
2. Confirma que la base de Render **no tiene datos reales**: `--clean` borra y recrea los objetos que vienen en el respaldo.
3. Restaura:
   ```powershell
   $RENDER_URL = "<External Database URL>"
   docker run --rm -v "${PWD}/respaldos:/r" postgres:16.4-alpine `
     pg_restore --no-owner --no-acl --clean --if-exists --single-transaction -d "$RENDER_URL" /r/postea-local.dump
   ```
4. **Resume**. Los logs deben mostrar `Migraciones al día.`, y `/health/db` debe responder `ok`.

Notas:
- **Usuarios:** tras restaurar, los usuarios de Render son los de tu base local. El admin de `ADMIN_EMAIL` se recrea solo si no existe.
- **Confirmación de URL:** la confirmación de la URL de QR viene de la base local. Si apunta a otra URL, los QR quedan provisionales hasta volver a confirmar.
- **`--single-transaction`:** si algo falla, no se aplica nada.

## 11. Ancho de banda (5 GB/mes)

Medido con imágenes sintéticas pesimistas (WebP de 1600 px ≈ 352 KB; una foto real suele pesar menos). HTML, CSS, JS y SVG van comprimidos con Brotli o gzip.

| Recurso | Sin comprimir | Transferido |
|---|---|---|
| Ficha `/f/:slug` (HTML) | 21 KB | **2,7 KB** |
| Inicio (HTML) | 16 KB | **2,9 KB** |
| Muro con 450 tarjetas (HTML) | 722 KB | **9,5 KB** |
| `/pantalla` (cada 30 s) | 3,6 KB | **1,1 KB** |
| `app.css` + `catalogos.css` + `form.js` | 37 KB | **9,7 KB** (caché 1 día) |
| Logos (blanco 6,7 + naranja 6,4 + lockup 11,6 KB) | — | 25 KB (caché 7 días) |
| Imagen original 1600 px | — | 352 KB |
| **Variante 1080 px** (tarjetas y ficha en celular) | — | **91 KB** |

- **Variante de 1080 px:** las tarjetas (inicio, muro y "Conecta") usan siempre esta variante. Desde el 09/10 la ficha también usa solo esta variante: la original es la del póster (hasta ~4000 px y 1–2 MB) y solo la piden la vista previa y la pieza impresa.
- **Caché de imágenes:** `Cache-Control: public, max-age=300` y `ETag` calculado en la base. Una revalidación responde **304** sin leer la imagen.

**Por visita:**
- **Ficha desde el QR, caché vacía:** ~2,7 + 17 (CSS, JS y logo) + 91 (imagen) = **~110 KB**. Si baja hasta "Conecta", se suman 3 variantes: **~385 KB**.
  - Antes eran ~1,4 MB: la imagen de 1600 px en la ficha y en las 3 relacionadas, y HTML sin comprimir.
- **Ficha siguiente, con caché:** ~2,7 KB + imágenes nuevas, de 90 a 365 KB.
- **Inicio:** ~2,9 + 15 + 18 (logos) + 6 × 91 = **~580 KB**.
- **Muro:** el HTML pesa poco, pero cada tarjeta que se ve carga su imagen de 91 KB (carga diferida). Recorrer 150 tarjetas ≈ 13,7 MB. **Es lo que más consume.**
- **Televisor:** ~130 KB por hora; despreciable.

**Capacidad en 5 GB:**
- ~13.000 aperturas de ficha completas, con "Conecta" y caché vacía;
- o ~45.000 si no bajan hasta "Conecta";
- o ~9.000 sesiones típicas de visitante (escanea, lee 1 o 2 fichas, invierte o comenta, ~0,55 MB);
- o ~370 recorridos completos del muro.

Revisa el consumo en Render → Workspace → **Billing / Usage** durante el evento.

## 12. Lista de verificación previa al despliegue

- [ ] `.env` **no** versionado (`git ls-files .env` vacío). `npm test` pasa en local.
- [ ] `docker build -t postea .` y simulación: `docker run --rm -p 8080:8080 -e PORT=8080 -e DATABASE_URL=... -e DB_SSL=false -e SESSION_SECRET=... postea` → `/health` y `/health/db` responden `ok`.
- [ ] Base creada **el 6 oct (apertura)** o lo antes posible, y **`DB_EXPIRA_EN`** configurada con su fecha de vencimiento.
- [ ] `BASE_URL` definitiva (https) **antes** de generar e imprimir QR; dominio propio configurado si aplica.
- [ ] `ADMIN_EMAIL` y `ADMIN_PASSWORD` configurados. Tras el primer ingreso: contraseña cambiada y `ADMIN_PASSWORD` borrada (sección 8).
- [ ] Web y base en Virginia. `DATABASE_URL` = *Internal* URL. Health Check Path `/health`. Docker Command vacío.
- [ ] Logs del primer arranque: `Migraciones al día.` y `POSTEA disponible en http://0.0.0.0:<PORT>`.
- [ ] **Diagnóstico del proxy** revisado desde un celular (IP real y HTTPS = sí).
- [ ] Panel "Base de datos en Render" en verde (vencimiento y tamaño).
- [ ] Datos locales migrados, si aplica (sección 10), antes de abrir la convocatoria.
- [ ] ZIP de QR y piezas generados **antes** de la exhibición. Con 0,1 CPU, el ZIP de 450 fichas tarda ~2 min; las visitas siguen atendiéndose.
- [ ] `autoDeploy` en `false` desde el 20 de octubre.
- [ ] Monitor externo a `/health` (horario del evento) y a `/health/db` (alertas).
- [ ] Respaldo diario (Admin → Exportar → ZIP) y `pg_dump` final. IP retirada de Access Control después de cada uso.
