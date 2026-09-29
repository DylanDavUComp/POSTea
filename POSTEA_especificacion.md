# POSTEA. / tu ARTículo — Especificación técnica para desarrollo

> Documento de referencia para el agente de IA (vibe coding). Léelo completo antes de escribir código y vuelve a él al terminar cada fase.
> Organiza: **Observatorio IMAGO** · Fundación Universitaria Compensar (UCompensar) · **Semana de Innovación y Emprendimiento 2026**.

---

## 1. Contexto

POSTEA tu ARTículo saca las investigaciones de UCompensar a los espacios cotidianos del campus. Cada investigación se presenta como un **post estilo Instagram impreso** (medio pliego), pegado en los vidrios del **piso 10 con terraza**, agrupado por **territorios temáticos**. Cada post tiene un **QR** que lleva a la **ficha de investigación**, donde el visitante puede **invertir simbólicamente** en la idea o **dejar un comentario**.

Recorrido del visitante: **01 Descubre** (ve el post) → **02 Escanea** (QR) → **03 Explora** (lee la ficha) → **04 Conecta** (invierte / comenta / ve relaciones con otras disciplinas).

Esta aplicación web hace posible lo que el PDF en SharePoint no puede: la inversión simbólica, los comentarios, el registro de usuarios y las métricas. El PDF en SharePoint se mantiene como respaldo opcional (enlace dentro de la ficha).

### Cifras y reglas del documento base
- 22 programas académicos × 3 investigaciones = **66 posts proyectados**. Las especializaciones también pueden presentar posts.
- Cada programa **selecciona** sus 3 investigaciones.
- Participan: **investigadores, semilleros, proyectos de grado, pasantes**.
- Se pueden postear investigaciones **terminadas** o **en desarrollo**.
- Facultades / escuela: **Facultad de Ingeniería**, **Escuela de Negocios**, **Facultad de Ciencias Sociales y de la Educación**.
- Territorios temáticos (mockup): **Ciudad y Cultura**, **Sostenibilidad y Territorio**, **Consumo y Sociedad**, **Innovación y Tecnología**, **Comunicación y Creatividad**. Deben ser editables por el admin.

### Cronograma 2026 (configurable desde el panel admin)
| Fecha | Hito | Efecto en la app |
|---|---|---|
| 05 oct | Apertura convocatoria | Autores pueden crear y enviar fichas |
| 19 oct | Cierre | Se bloquea crear/enviar (solo admin puede reabrir) |
| 20–26 oct | Producción | Revisión IMAGO, generación de QR y piezas imprimibles |
| 27–30 oct | Exhibición | Inversión y comentarios activos; modo pantalla |

---

## 2. Stack obligatorio (pensado para Render Free)

- **Runtime:** Node.js 20 LTS.
- **Servidor:** Express + plantillas **EJS** renderizadas en servidor (páginas ligeras que cargan rápido en celular tras escanear un QR). JavaScript de cliente mínimo, sin framework SPA.
- **Estilos:** CSS propio (un solo archivo `public/css/app.css`), mobile-first. Fuente Roboto (Google Fonts) con fallback `system-ui, sans-serif`.
- **Base de datos:** PostgreSQL mediante el paquete `pg`. Migraciones SQL numeradas en `/migrations` ejecutadas por un script propio (`npm run migrate`) que registra las aplicadas en una tabla `schema_migrations`.
- **Sesiones:** `express-session` + `connect-pg-simple` (sesiones guardadas en Postgres, nunca en memoria).
- **Seguridad:** `bcrypt` (contraseñas), `helmet`, `express-rate-limit` (login, registro, comentarios, inversiones), protección CSRF con token en sesión para todos los formularios POST, validación con `zod`.
- **Imágenes:** `multer` en memoria + `sharp` para redimensionar a máx. 1600 px de lado y convertir a WebP (calidad ~80). **Se guardan en Postgres (columna `bytea`)**, no en disco.
- **QR:** paquete `qrcode` (PNG y SVG).
- **Sin** Docker obligatorio, **sin** servicios de pago, **sin** almacenamiento en disco local.

### Restricciones de Render Free que el código DEBE respetar
1. **Sistema de archivos efímero:** todo lo subido al disco se pierde al reiniciar/redeploy. → Todo archivo (imágenes, PDFs opcionales) va en Postgres.
2. **El servicio se duerme tras ~15 min sin tráfico** y tarda cerca de un minuto en despertar. → Exponer `GET /health` (responde `200 ok` y hace `SELECT 1`) para un ping externo cada 10 min durante la exhibición. Páginas públicas livianas.
3. **Postgres Free: 1 GB, vence 30 días después de creada, sin backups, sin pooling.** → Pool de `pg` con `max: 5`; imágenes comprimidas; exportación completa (CSV + JSON) desde el panel admin; documentar `pg_dump` en el README.
4. El puerto viene en `process.env.PORT`. Conexión a DB con `DATABASE_URL` y SSL cuando `NODE_ENV=production` (`ssl: { rejectUnauthorized: false }`).

---

## 3. Roles y registro

La lectura de fichas y del muro es **pública, sin registro**. El registro solo se exige para actuar.

| Rol | Cómo se obtiene | Puede |
|---|---|---|
| `visitante` | Autoregistro | Invertir monedas, comentar, ver su historial |
| `autor` | Autoregistro eligiendo "Voy a postear" + programa → queda `pendiente` hasta que el coordinador de su programa lo active | Todo lo del visitante + crear/editar fichas de su programa, previsualizar el post, descargar su QR |
| `coordinador` | Lo asigna el admin (uno o más por programa) | Activar autores de su programa, revisar fichas, **seleccionar las 3** del programa, devolver con observaciones, verificar QR |
| `admin` (IMAGO) | Semilla inicial por variables de entorno | Todo: programas, territorios, usuarios, fechas, moderación, exportaciones, piezas de impresión |

### Formulario de registro (corto, pensado para celular frente al vidrio)
- Nombre completo · Correo · Contraseña (mín. 8) · Tipo de persona: *estudiante, docente, investigador, semillero, proyecto de grado, pasante, administrativo, egresado, externo* · Programa (opcional para visitantes, obligatorio para autores) · Check "Voy a postear una investigación".
- **Casilla obligatoria de autorización de tratamiento de datos personales** (Ley 1581 de 2012, Colombia) con enlace a `/privacidad`. Guardar fecha y versión aceptada.
- Si existe `ALLOWED_EMAIL_DOMAINS` (ej. `ucompensar.edu.co`), los **autores** deben usar ese dominio; los visitantes pueden usar cualquier correo, salvo que `VISITOR_DOMAIN_RESTRICTED=true`.
- Tras registrarse desde una ficha, volver automáticamente a esa ficha (`?next=/f/slug`) y ejecutar la acción que intentaba.
- Sesión persistente de 30 días.
- Recuperación de contraseña: el admin puede generar un enlace de restablecimiento de un solo uso (sin depender de correo). Envío por email solo si se configura `SMTP_*` (opcional, no bloquea el MVP).

---

## 4. Modelo de datos (PostgreSQL)

```
facultades(id, nombre, color_hex, orden)
programas(id, nombre, facultad_id→facultades, es_especializacion bool, cupo int default 3, activo bool)
territorios(id, nombre, slug, color_hex, icono, orden)

usuarios(id, nombre, email unique citext/lower, password_hash, rol enum[visitante,autor,coordinador,admin],
         estado enum[activo,pendiente,bloqueado], tipo_persona, programa_id null,
         acepta_datos_at timestamptz, acepta_datos_version, created_at, last_login_at)
coordinadores_programa(usuario_id, programa_id)  -- PK compuesta

investigaciones(id, slug unique, programa_id, territorio_id null, autor_id→usuarios,
    titulo, subtitulo null, pregunta_gancho,           -- titular del post
    descripcion, objetivo, metodologia, resultados,    -- secciones 01–04 de la ficha
    estado_investigacion enum[terminada,en_desarrollo],
    tipo enum[investigacion,semillero,proyecto_grado,pasantia],
    imagen bytea null, imagen_mime, imagen_credito null,
    sharepoint_url null,
    estado_flujo enum[borrador,enviada,seleccionada,devuelta,publicada,archivada],
    observaciones_revision text null,
    created_at, updated_at, publicada_at null)
investigadores(id, investigacion_id, nombre_completo, orden)   -- nombres del post, no requieren cuenta

inversiones(id, usuario_id, investigacion_id, monedas int >0, created_at)
comentarios(id, usuario_id, investigacion_id, tipo enum[pregunta,conexion,aplicacion],
            texto (máx 500), estado enum[visible,oculto,reportado], created_at)
visitas(id, investigacion_id, usuario_id null, origen enum[qr,web], user_agent_hash, created_at)

configuracion(clave pk, valor jsonb)  -- fechas, saldo_inicial, flags
sesiones  -- tabla de connect-pg-simple
tokens_reset(token_hash, usuario_id, expira_at, usado bool)
```

Índices: `investigaciones(estado_flujo, territorio_id)`, `inversiones(investigacion_id)`, `comentarios(investigacion_id, estado)`, `visitas(investigacion_id, created_at)`.

### Claves de `configuracion` (con valores por defecto)
- `fecha_apertura` = 2026-10-05, `fecha_cierre` = 2026-10-19T23:59 (America/Bogota)
- `fecha_exhibicion_inicio` = 2026-10-27, `fecha_exhibicion_fin` = 2026-10-30T23:59
- `saldo_inicial_monedas` = 100 · `nombre_moneda` = "Imagos"
- `inversion_activa` (bool) · `comentarios_activos` (bool) · `moderacion_previa` (bool, default false)
- `mostrar_ranking_publico` (bool)

Todas las fechas se interpretan en zona **America/Bogota**.

---

## 5. Reglas de negocio

1. **Ventana de convocatoria:** autores solo crean/envían entre apertura y cierre. El admin puede editar siempre.
2. **Flujo:** `borrador` → (autor envía) `enviada` → (coordinador) `seleccionada` o `devuelta` (con observaciones) → (admin IMAGO revisa y asigna territorio) `publicada`. `devuelta` vuelve a editable.
3. **Cupo:** un programa no puede tener más de `cupo` (3) investigaciones en `seleccionada` + `publicada`. Mostrar contador "2 de 3".
4. **Validaciones de ficha:** título ≤ 90 caracteres; pregunta gancho ≤ 80 (debe caber en el post); descripción, objetivo, metodología y resultados de 80 a 900 caracteres cada uno; 1 a 6 investigadores; imagen obligatoria para enviar (JPG/PNG/WebP, ≤ 5 MB antes de comprimir) con casilla "tengo derechos de uso de esta imagen".
5. **Slug** estable generado del título al crear (`ciudades-mas-caminables-3f9a`). **Nunca cambia** una vez publicada, porque está impreso en el QR.
6. **Inversión simbólica:** cada usuario recibe `saldo_inicial_monedas`. Saldo = inicial − suma de sus inversiones. Solo durante la exhibición y si `inversion_activa`. Puede repartir entre varias investigaciones; no puede invertir en investigaciones donde figura como autor. Operación en **transacción** con bloqueo (`SELECT … FOR UPDATE` sobre el usuario) para impedir saldo negativo.
7. **Comentarios:** tipos *Pregunta*, *Conexión*, *Posible aplicación* (según la ficha del documento). Máx. 500 caracteres, límite de 10 por hora por usuario, filtro básico de palabras ofensivas configurable. Visibles de inmediato salvo `moderacion_previa`. Cualquier usuario puede reportar; el admin oculta.
8. **Visitas:** registrar cada apertura de ficha (`?src=qr` → origen `qr`). No contar recargas del mismo usuario/agente en 30 min.
9. Las acciones deshabilitadas por viabilidad técnica o fecha muestran un mensaje amable ("La inversión se activa el 27 de octubre"), nunca un error.

---

## 6. Páginas y rutas

### Públicas
- `/` — Landing del proyecto: lema "El conocimiento se comparte, las ideas se conectan", cómo funciona (4 pasos), quiénes participan, cronograma, botón al muro.
- `/muro` — Galería de posts publicados como tarjetas estilo Instagram, agrupadas por territorio, con filtros por facultad, programa, territorio y estado (terminada / en desarrollo) y buscador.
- `/f/:slug` — **Ficha (destino del QR). Página más importante: debe pesar poco y verse perfecta en celular.** Encabezado POSTEA, etiqueta INVESTIGACIÓN, título, subtítulo, facultad y programa, imagen, investigadores, secciones numeradas 01 Descripción · 02 Objetivo · 03 Metodología · 04 Resultados, y al final dos bloques: **"Invierte en esta idea"** (participa en la subasta simbólica del conocimiento) y **"Deja tu comentario"** (comparte una pregunta, una conexión o una posible aplicación). Debajo: comentarios visibles, total invertido (si está habilitado) y sección **"Conecta"** con 3 investigaciones relacionadas (mismo territorio, distinta facultad primero). Enlace opcional "Ver ficha en PDF (SharePoint)".
- `/ranking` — Investigaciones con más inversión y más comentarios, filtrable por territorio/facultad (si `mostrar_ranking_publico`).
- `/pantalla` — Modo pantalla completa para un televisor en el piso 10: ranking en vivo que se refresca cada 30 s, contador de visitantes, últimos comentarios, rotación por territorio.
- `/registro`, `/ingresar`, `/salir`, `/privacidad`, `/restablecer/:token`.
- `/health`.

### Usuario registrado
- `/mi-cuenta` — Saldo de monedas, inversiones hechas, comentarios.

### Autor
- `/panel` — Mis investigaciones con estado y observaciones.
- `/panel/investigaciones/nueva` y `/panel/investigaciones/:id/editar` — Formulario de ficha con contador de caracteres en vivo y guardado como borrador.
- `/panel/investigaciones/:id/vista-previa` — Vista previa del **post** y de la **ficha** tal como se verán.

### Coordinador
- `/coordinacion` — Autores pendientes de su programa (activar/rechazar), fichas enviadas, botón **Seleccionar** (respetando cupo 3), **Devolver** con observaciones, contador de cupo, estado de QR verificado.

### Admin IMAGO
- `/admin` — Tablero: posts por estado, por programa (quién falta), por territorio; visitantes registrados; escaneos por día; inversiones y comentarios totales.
- `/admin/programas`, `/admin/territorios`, `/admin/usuarios` (cambiar rol, asignar coordinadores, bloquear, generar enlace de restablecimiento), `/admin/configuracion` (fechas y flags), `/admin/moderacion`.
- `/admin/investigaciones` — Todas; asignar territorio; publicar; archivar.
- `/admin/impresion` — Generación de piezas (ver §7) individual y por lote, y descarga ZIP de todos los QR.
- `/admin/exportar` — CSV de investigaciones, usuarios (sin contraseñas), inversiones, comentarios y visitas; y un JSON completo de respaldo.
- Importación CSV de programas (`nombre,facultad,es_especializacion`). **No inventar nombres de programas**: la semilla solo trae las 3 facultades, los 5 territorios y el usuario admin.

---

## 7. Post imprimible y QR

- **El QR es por investigación, no por usuario.** El registro de un autor no genera ningún QR. Cada investigación obtiene su `slug` al crearse, y su QR apunta a `${BASE_URL}/f/${slug}?src=qr`.
- **El QR se genera al vuelo** (en cada solicitud, a partir de `BASE_URL` + slug) y **nunca se guarda** en la base de datos ni en disco. Así, cambiar `BASE_URL` (de `localhost` a la URL definitiva de Render) actualiza todos los QR sin migraciones ni cambios de código.
- **Bloqueo de URL para impresión:** en `configuracion` existe `url_qr_confirmada` (bool, default false). Mientras sea false, o si `BASE_URL` contiene `localhost`, toda pieza imprimible y todo QR descargado muestran una marca visible "QR PROVISIONAL – NO IMPRIMIR". Solo el admin puede confirmarla desde `/admin/configuracion`, que muestra la URL actual y un aviso: "Después de imprimir, esta URL y los slugs no deben cambiar".
- El slug se genera al crear la ficha, puede regenerarse mientras está en borrador y queda **bloqueado** desde que pasa a `publicada`.
- Corrección de errores nivel **Q**, margen de 4 módulos, color oscuro sobre blanco. Descarga en PNG (1200 px) y SVG. Botón "Probar QR" que abre la URL.
- **Pieza imprimible** en `/admin/impresion/:id` (también accesible al autor en vista previa): página HTML con CSS `@page` al tamaño **medio pliego (50 × 70 cm, vertical)** lista para "Imprimir → Guardar como PDF". Estructura según el documento base:
  1. **Encabezado:** logo/avatar, cuenta "UCompensar" y la facultad o escuela, "•••".
  2. **Imagen principal** de la investigación.
  3. **Pregunta o frase** (titular grande que despierte curiosidad), con acento naranja.
  4. **Investigadores:** nombres completos.
  5. **QR + llamado a la acción:** "Escanea y conoce la investigación". QR de al menos 8 cm de lado.
  6. **Elementos de Instagram** decorativos (corazón, comentario, enviar, indicador de carrusel, guardar), no funcionales.
  Etiqueta del territorio con su color en una esquina.
- Aviso visible en la vista previa: "Imagen de referencia. Diseño sujeto a ajustes." y recomendación de hacer una prueba de impresión.

---

## 8. Identidad visual

- Morado profundo `#2A1150` (fondos, títulos), morado medio `#5B2A9E`, naranja `#FF6B00` (acentos, llamados a la acción), blanco `#FFFFFF`, gris texto `#4A4A5A`.
- Colores de facultad: Ingeniería `#E8712F`, Escuela de Negocios `#1E6B2B`, Ciencias Sociales y de la Educación `#1A9FD6`. Color de "Conecta" `#9B2C8E`.
- Logotipo tipográfico: **POSTEA.** en negrita + "/ tu **ART**ículo" con "ART" en naranja.
- Pie institucional: "Fundación Universitaria Compensar · Observatorio IMAGO · Semana de Innovación y Emprendimiento 2026 · Vigilada MinEducación".
- Tarjetas redondeadas (radio 16–24 px), mucho aire, botones grandes (mín. 44 px de alto) para uso con el pulgar. Contraste AA. Sin imágenes remotas.

---

## 9. Variables de entorno

```
DATABASE_URL=            # la entrega Render (Internal Database URL)
SESSION_SECRET=          # cadena aleatoria larga
BASE_URL=                # https://postea-imago.onrender.com (sin / final) — define los QR
NODE_ENV=production
ADMIN_EMAIL=             # admin inicial (se crea si no existe)
ADMIN_PASSWORD=
ALLOWED_EMAIL_DOMAINS=   # opcional, separado por comas
VISITOR_DOMAIN_RESTRICTED=false
TZ=America/Bogota
```

Incluir `.env.example`. Nunca subir `.env` al repositorio.

---

## 10. Despliegue en Render

Incluir `render.yaml` (Blueprint):
- Servicio **web** `postea-imago`, plan `free`, runtime `node`, `buildCommand: npm ci`, `startCommand: npm run migrate && npm start`, `healthCheckPath: /health`.
- Base de datos `postea-db`, plan `free`, con su `connectionString` enlazado a `DATABASE_URL`.
- `SESSION_SECRET` con `generateValue: true`.
- Web y base de datos en **la misma región**.

README con: cómo correr local (Postgres local o Docker opcional), cómo desplegar, cómo hacer `pg_dump "$DATABASE_URL" > respaldo.sql`, cómo configurar un ping externo a `/health` cada 10 min durante la exhibición, y la advertencia de las fechas de vencimiento de la DB gratuita.

---

## 11. Fases de trabajo y criterios de aceptación

Trabaja en este orden. Al terminar cada fase: la app arranca sin errores, las migraciones corren desde cero y se actualiza `PROGRESO.md` con lo hecho y lo pendiente.

1. **Base:** estructura del proyecto, Express, EJS, CSS base con identidad visual, conexión a Postgres, migraciones, semilla, `/health`, layout con pie institucional. ✔ `npm run migrate && npm start` levanta en local.
2. **Cuentas:** registro, ingreso, salida, sesiones en Postgres, roles, autorización de datos, CSRF, límites de intentos, `?next=`. ✔ Un visitante se registra desde el celular en menos de 1 minuto.
3. **Fichas (autor):** CRUD de investigación con validaciones, investigadores, subida y compresión de imagen, vista previa de post y ficha. ✔ Un autor completa y envía una ficha.
4. **Flujo de selección:** activación de autores, selección con cupo 3, devolución con observaciones, publicación y asignación de territorio por admin. ✔ No es posible seleccionar una cuarta investigación en un programa.
5. **Público:** landing, muro con filtros, ficha `/f/:slug` optimizada para móvil, "Conecta" con relacionadas, registro de visitas. ✔ La ficha carga en celular y se lee sin zoom.
6. **Interacción:** billetera de monedas, inversión transaccional, comentarios con tipos, reportes, moderación, activación por fechas/flags. ✔ Dos inversiones simultáneas nunca dejan saldo negativo.
7. **Admin y datos:** tablero, gestión de programas/territorios/usuarios/configuración, exportaciones CSV/JSON, `/ranking`, `/pantalla`. ✔ Se exportan todos los datos en un clic.
8. **Impresión:** QR PNG/SVG, pieza de medio pliego, lote y ZIP de QR. ✔ El QR impreso a 8 cm se lee desde 1 m.
9. **Despliegue:** `render.yaml`, README, `.env.example`, revisión de seguridad final. ✔ Despliega en Render con un solo Blueprint.

---

## 12. Fuera de alcance (no construir salvo pedido explícito)

Pagos reales, aplicación móvil nativa, integración directa con la API de SharePoint o Instagram, inicio de sesión con Microsoft/Google, chat en tiempo real, notificaciones push.
