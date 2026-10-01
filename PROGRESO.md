# Progreso

## Fase 1 · Base

Hecho:

- Estructura Node.js, Express y EJS; página inicial y página de error con identidad visual móvil.
- Pool PostgreSQL de cinco conexiones, SSL en producción y endpoint `GET /health` con `SELECT 1`.
- Migraciones SQL numeradas, tabla `schema_migrations` y datos base de facultades, territorios y configuración.
- Semilla manual para la cuenta admin. No se crean programas ni investigaciones ficticias.
- Plantilla `.env.example` y documentación de arranque local.

Verificado localmente con PostgreSQL 16 temporal y Node.js 24 (el proyecto está orientado a Node.js 20):

- `npm run migrate` desde una base vacía aplicó las dos migraciones; una segunda ejecución no reaplicó ninguna.
- `npm run seed` creó el admin. La base quedó con 2 migraciones, 3 facultades, 5 territorios y 1 usuario.
- `npm start` levantó la app. `/` respondió HTTP 200 con el pie institucional y los cuatro pasos; `/health` respondió HTTP 200 y `ok`.
- `node --check` pasó para los scripts principales y `npm audit` no reportó vulnerabilidades al momento de la prueba.

Cómo probar:

1. Configurar `.env` a partir de `.env.example` con PostgreSQL disponible.
2. Ejecutar `npm ci`, `npm run migrate`, `npm run seed` y `npm start`.
3. Abrir `/` y consultar `/health`; debe devolver `ok` cuando la base responda.

## Fase 2 · Cuentas

Hecho:

- Enlaces visibles a registro, ingreso y cuenta en la cabecera y la página inicial.
- Registro de visitantes con validación, contraseña bcrypt y consentimiento fechado/versionado. La opción de autor requiere un programa activo y queda pendiente de activación.
- Inicio y cierre de sesión con almacenamiento PostgreSQL, cookie de 30 días, renovación de sesión al autenticar y protección CSRF en los formularios POST.
- Límites de intentos para ingreso y registro; comprobación de dominios permitidos; retorno seguro mediante `?next=`.
- Vista de cuenta y aviso de privacidad para pruebas.

Verificado localmente:

- El admin sembrado pudo ingresar y ver `/mi-cuenta`.
- Un visitante de prueba se registró, entró a su cuenta y cerró sesión; la cuenta temporal se eliminó al finalizar y quedó solo el admin.
- Un POST sin token CSRF respondió 403. Un `?next=//evil.example` se reemplazó por `/mi-cuenta`.
- `/`, `/registro` y `/privacidad` respondieron HTTP 200. Las migraciones continuaron al día.

Cómo probar:

1. Reiniciar el servidor (`Ctrl+C`, `npm start`) para cargar las rutas nuevas.
2. Abrir `/registro` y crear un visitante; comprobar que redirige a `/mi-cuenta`.
3. Cerrar sesión e ingresar con la cuenta creada o con el admin sembrado.

Limitaciones actuales: solo hay un programa DEMO para probar autores; los programas reales deben cargarse en el panel admin de la fase 7. La ficha `/f/:slug` y la acción de invertir todavía no existen, así que el retorno a la ficha y la reanudación de esa acción se completarán en las fases 5 y 6. El aviso de privacidad requiere revisión institucional antes de publicar.

## Fase 3 · Fichas de autor

Hecho:

- Panel privado `/panel` con borradores y estados; crear, editar, eliminar borradores y ver vista previa de post y ficha.
- Validación al enviar: longitudes, investigadores, tipo y estado, imagen obligatoria y derechos de uso. Los borradores permiten campos incompletos.
- Imágenes JPG/PNG/WebP recibidas en memoria, límite de 5 MB, redimensionadas a máximo 1600 px y guardadas como WebP en PostgreSQL. Las imágenes no publicadas solo se sirven al autor o admin.
- Slug generado al crear, regenerable en borrador, sin cambio después de publicar. La ventana de convocatoria se consulta en `configuracion`.
- `seed:demo` crea un programa y autor marcados DEMO y abre la convocatoria solo en desarrollo. No se ejecuta en producción ni automáticamente.

Verificado localmente:

- `npm run test:phase3`: login de autor, borrador, rechazo de envío sin imagen, envío completo, imagen WebP de 1600 px, vista previa y eliminación de borrador; también rechazo de imagen mayor a 5 MB y protección de panel e imagen privada.
- `npm run test:migrations`: dos migraciones desde base vacía, repetición sin duplicados, tres facultades, cinco territorios y ningún programa ni usuario inventados en la semilla base.
- Corrección de formulario: faltaba cerrar la etiqueta HTML `<form>`, lo que absorbía el campo CSRF dentro de `action` y dejaba ambos botones sin enviar. Se corrigió el marcado y se añadió una prueba de regresión. Un navegador Edge real completó Guardar borrador y Enviar ficha en el servidor del puerto 3000, con confirmaciones visibles.

Cómo probar:

1. Ingresar con `autor.demo@example.com` y la contraseña `DEMO_AUTHOR_PASSWORD` de `.env`.
2. Abrir `/panel`, crear una ficha, guardar borrador, editar y enviar con una imagen y los campos completos.
3. Revisar la vista previa. La revisión por coordinador empieza en la fase 4.

## Fase 4 · Revisión y publicación

Implementado:

- Panel `/coordinacion` para activar/rechazar autores, revisar fichas e imágenes privadas y seleccionar o devolver con observaciones.
- Los coordinadores acceden solo a sus programas asignados; el admin puede revisar todos.
- Cupo por programa compartido entre seleccionadas y publicadas, con transacciones y bloqueo del programa para impedir excederlo con solicitudes simultáneas.
- Panel `/admin/investigaciones` para publicar seleccionadas con territorio obligatorio y archivarlas; se conserva el bloqueo de slug tras publicar.
- Navegación visible según rol y mensajes de éxito/error en cada acción.
- Prueba `npm run test:phase4`: activación/rechazo, permisos, CSRF, revisión privada, cuatro selecciones simultáneas para tres cupos, devolución editable, publicación y archivo. Datos temporales eliminados al finalizar.
- Regresión de fase 3 verificada: borrador, imagen, envío y vista previa siguen funcionando.

Para probar: ingresar como admin, abrir Coordinación, seleccionar una ficha enviada y luego abrir Publicación IMAGO para asignar territorio y publicar. La gestión de asignaciones de coordinadores queda en fase 7 y los QR en fase 8. La página pública se construye en fase 5.

Entorno: PostgreSQL se recuperó en el puerto 15432 usando el volumen existente `postea_dev_data`, porque Windows reservó 55432. Contenedor activo: `postea-dev-db-15432`; `.env` actualizado.

## Fase 5 · Público

Hecho:

- Landing `/` con lema, cuatro pasos, quiénes participan y cronograma de cuatro hitos leído de `configuracion`, con la etapa actual marcada ("Ahora").
- Muro `/muro` con tarjetas estilo Instagram agrupadas por territorio, filtros por facultad, programa, territorio y estado, buscador (título, pregunta, descripción, programa e investigadores) y estado vacío amable.
- Colores de facultad (borde y anillo del avatar) y de territorio (etiqueta) servidos desde la base en `/css/catalogos.css`, porque la CSP no permite estilos en línea y el admin puede editarlos. Íconos decorativos de Instagram en SVG en línea, sin imágenes remotas.
- Ficha `/f/:slug` optimizada para móvil: etiqueta INVESTIGACIÓN y territorio, facultad y programa, imagen, investigadores, secciones 01–04, enlace opcional a SharePoint (solo `https://`), bloques "Invierte en esta idea" y "Deja tu comentario" con mensaje según fecha y flag ("La inversión se activa el 27 de octubre") y botones "Crear mi cuenta" / "Ya tengo cuenta" que regresan al mismo bloque de la ficha (`?next=/f/slug#invierte`).
- "Conecta": 3 investigaciones del mismo territorio, primero las de otra facultad.
- Visitas: `?src=qr` → origen `qr`; sin contar HEAD ni prefetch; deduplicación de 30 minutos por usuario o por huella HMAC de IP y agente (no se guarda en claro), segura ante recargas concurrentes. Solo se sirven fichas e imágenes publicadas.

Verificado localmente:

- `npm run test:phase5`: muro solo con publicadas, cada filtro, búsqueda por investigador, parámetros inválidos sin error, 404 en borradores, enviadas, seleccionadas, archivadas e inexistentes, HTML escapado, orden de "Conecta", mensajes por fecha con fechas fijas, etiquetas del cronograma, hoja de colores, enlaces de registro e ingreso con retorno a la ficha, redirección tras ingresar a `/f/slug#invierte` y deduplicación de visitas.
- Regresión: `test:phase3`, `test:phase4` y `test:migrations` siguen pasando.
- Capturas con Edge sin interfaz a 500 px (el ancho mínimo en Windows) de `/`, `/muro` y la ficha: sin desborde horizontal, texto legible sin zoom y botones de 44 px.

Cómo probar:

1. Reiniciar el servidor (`Ctrl+C`, `npm start`) para cargar las rutas nuevas.
2. Publicar una ficha desde Publicación IMAGO y abrir `/muro`; probar filtros y buscador.
3. Abrir la ficha desde el celular (`/f/slug?src=qr`), tocar "Crear mi cuenta" y comprobar que tras registrarse vuelve al bloque "Invierte en esta idea".

Pendiente para la fase 6: formularios reales de inversión y comentarios dentro de los bloques (hoy muestran el aviso de activación), comentarios visibles y total invertido en la ficha.

### Corrección posterior · Explorar y Cerrar sesión

- Causa: el servidor del puerto 3000 seguía corriendo el código anterior a la fase 5 (sin la ruta `/muro`), mientras las plantillas EJS sí se leían actualizadas del disco. `/muro` daba 404 y, al cerrar sesión, la redirección a `/` renderizaba la nueva landing sin datos del cronograma y aparecía "Ocurrió un problema".
- Se reinició el servidor en modo `node --watch` para que recargue los cambios de código automáticamente.
- Pulido: botón "Salir" en el encabezado de todas las páginas, mensaje "Cerraste sesión" en la página inicial, cerrar sesión con la sesión vencida o desde una pestaña vieja ya no muestra "Formulario vencido", y `GET /salir` redirige en lugar de dar 404.
- Nueva prueba `npm run test:nav`: todos los enlaces del encabezado responden 200 para anónimo, visitante y admin; salida desde el encabezado, salida repetida sin error y CSRF con sesión activa. `npm test` corre toda la batería.

## Fase 6 · Interacción

Hecho:

- Migración `003_interaccion.sql`: estado `pendiente` para comentarios, tabla `reportes_comentario`, marca de revisión de IMAGO (`moderado_at`, `moderado_por`), tokens de operación únicos en inversiones y comentarios, y lista base de palabras no permitidas.
- Billetera: saldo = `saldo_inicial_monedas` − inversiones hechas. Se ve en la ficha y en `/mi-cuenta`.
- Inversión desde la ficha con cantidades rápidas para el pulgar (5, 10, 20, 50 o todo el saldo) u otra cantidad. Es transaccional con `SELECT … FOR UPDATE` sobre el usuario. El autor no invierte en su propia investigación. Solo funciona durante la exhibición y con `inversion_activa`; fuera de eso se muestra un aviso amable.
- Total invertido y número de personas en la ficha, visible desde el inicio de la exhibición.
- Comentarios tipo Pregunta, Conexión o Posible aplicación, de 3 a 500 caracteres, con contador en vivo. Máximo 10 por hora por usuario, filtro de palabras sin tildes ni mayúsculas (incluye plurales) y borrador conservado si hay error. En público se muestra solo "Nombre I.".
- Moderación previa opcional: el comentario queda pendiente y solo lo ve quien lo escribió.
- Reportes: cualquier cuenta reporta comentarios ajenos; el comentario sale de la vista pública hasta que IMAGO decida. Si IMAGO lo aprueba, nuevos reportes ya no lo ocultan.
- `/admin/moderacion`: por aprobar, reportados (con conteo), publicados recientes y ocultos; botones Aprobar/Mostrar/Ocultar; lista de palabras editable; interruptor de moderación previa. Enlace "Moderación" en el encabezado del admin.
- Sin cuenta: la persona elige la cantidad o escribe el comentario, pasa por el registro y regresa a la ficha con la cantidad preseleccionada ("Confirma tu inversión de 10 Imagos"). El texto del comentario se guarda en el navegador y se recupera al volver.
- Si la sesión venció mientras leía la ficha, invertir o comentar lleva a ingresar y de vuelta al bloque, sin "Formulario vencido".
- Protección de doble clic: token de operación en el servidor y botón deshabilitado en el cliente.
- Límites por cuenta y no por IP para invertir, comentar y reportar. El registro admite 60 por IP cada 15 minutos, y el ingreso cuenta solo los intentos fallidos por IP y correo, porque en la exhibición muchas personas comparten la wifi del campus.
- `/mi-cuenta`: saldo grande, historial de inversiones y comentarios con su estado.
- `npm run demo:exhibicion` (solo desarrollo) abre la exhibición desde hoy; `-- --restaurar` vuelve a las fechas oficiales.

Verificado:

- `npm run test:phase6`, criterio de aceptación: 10 inversiones simultáneas de 30 con saldo 100 dejan exactamente 3 (90). Luego 25 llamadas simultáneas de 7 sobre saldo 10 dejan solo 1, y el saldo nunca queda negativo. Prueba de mutación: sin el `FOR UPDATE` la prueba falla.
- La misma prueba cubre doble clic en inversión y comentario, cantidades inválidas, autoría, flag apagado, exhibición no iniciada o terminada, flujo sin cuenta, HTML escapado, filtro de palabras con borrador, tipo inválido, más de 500 caracteres, límite de 10 por hora, moderación previa, reporte propio bloqueado, reporte, aprobación, ocultamiento, ajustes (solo admin) y Mi cuenta.
- `npm test` completo: migraciones (ahora 3), navegación y fases 3 a 6.
- Captura móvil de la ficha con la exhibición DEMO abierta.

Cómo probar:

1. `npm run demo:exhibicion` (ya ejecutado en tu base local; abre la exhibición hasta el 13 de octubre).
2. Abrir una ficha publicada sin sesión, elegir 10 Imagos, tocar "Crear cuenta e invertir", registrarse y confirmar.
3. Comentar, reportar desde otra cuenta y revisar en **Moderación** como admin.
4. Al terminar: `npm run demo:exhibicion -- --restaurar`.

## Fase 7 · Admin y datos

Hecho:

- `/admin` tablero:
  - Indicadores: publicados frente a proyectados, personas registradas por rol, escaneos QR, Imagos invertidos y comentarios, con enlace a lo que falta por moderar.
  - Barras SVG accesibles, sin estilos en línea: posts por estado, publicados por territorio, aperturas por día (14 días, QR y web) y "Programas: quién falta".
- Menú de administración común a todas las secciones. El encabezado muestra un solo enlace "Admin IMAGO".
- `/admin/programas`: crear y editar. Tiene cupo con bloqueo del programa (no baja de lo ya ocupado) y activar/desactivar. Importa CSV pegado o elegido desde un archivo, con estas reglas:
  - Facultad por nombre, sin importar tildes ni mayúsculas.
  - `es_especializacion` admite sí o no.
  - Separador `,` o `;`, con BOM.
  - Todo o nada, y actualiza los existentes.
  - Admite hasta 256 KB solo en esa ruta.
- `/admin/territorios`: crear, editar (nombre, slug derivado, color, ícono, orden) y eliminar solo si no tiene investigaciones.
- `/admin/usuarios`:
  - Búsqueda, filtros y paginación.
  - Rol, estado, programa y programas coordinados.
  - Bloquear cierra las sesiones.
  - El admin no puede quitarse el rol ni bloquearse.
  - Enlace de restablecimiento de un solo uso: 72 h, solo hash en la base, se muestra una vez e invalida el anterior.
- `/restablecer/:token`: nueva contraseña, cierre de sesiones anteriores y aviso en ingresar.
- `/admin/configuracion`: fechas en hora de Bogotá con validación de orden, saldo inicial, nombre de la moneda y cuatro funciones. Confirmar la URL de los QR queda bloqueado si `BASE_URL` es localhost.
- `/admin/exportar`: CSV de investigaciones (con métricas), usuarios (sin contraseñas), inversiones, comentarios, visitas y programas. Respaldo JSON completo (con o sin imágenes) y **ZIP con todo en un clic**.
  - Los CSV van con BOM UTF-8 y protección contra inyección de fórmulas.
  - El ZIP no tiene dependencias (`src/zip.js`).
- `/ranking`: más inversión y más comentadas, con filtros por facultad y territorio. Solo es público con `mostrar_ranking_publico`; el admin ve una vista previa. Hay un botón "Ver ranking" en el muro.
- `/pantalla`: modo televisor 16:9 que se recarga cada 30 s sin JavaScript. Rota un territorio por recarga, muestra contadores en vivo y los últimos comentarios. El ranking solo aparece si es público.
- **Corrección de fondo:** `express-session` guardaba la sesión después de enviar la respuesta. Una redirección seguida muy rápido podía leer la sesión vieja, y se perdían avisos como "¡Invertiste 10 Imagos!". Ahora la sesión se guarda antes de redirigir y antes de mostrar un aviso. Se detectó porque la prueba de fase 7 fallaba de forma intermitente; tras el arreglo pasó 4 de 4 veces y la batería completa también.
- Prueba de fase 5 independiente de la configuración local (fija su propio escenario y lo restaura).

Verificado:

- `npm run test:phase7`:
  - Permisos (403/302).
  - Importación CSV: con errores no importa nada; correcta con `;`, BOM y tildes; un CSV de más de 16 KB pasa.
  - Cupo mínimo, tablero sin `style=`, territorios (color en la hoja de catálogo, eliminación bloqueada si está en uso).
  - Coordinador con varios programas, bloqueo que cierra sesión, protección del propio admin.
  - Restablecimiento: un uso, solo hash, cierra sesiones.
  - Configuración (orden de fechas, hora de Bogotá), URL de QR con localhost bloqueada.
  - Ranking (orden, visibilidad, vista previa), pantalla (refresco de 30 s, sin ranking si no es público).
  - Exportaciones: BOM, sin contraseñas, fórmula neutralizada, imagen WebP en el JSON, ZIP con los 7 archivos.
- `npm test` completo: migraciones, navegación y fases 3 a 7.
- Capturas: tablero a 1280 px, usuarios a 500 px y pantalla a 1920×1080.

Cómo probar:

1. Ingresar como admin y abrir **Admin IMAGO**.
2. Importar programas con un CSV de prueba (o el oficial), asignar un coordinador en Usuarios y probar el enlace de restablecimiento.
3. En Configuración activar "Ranking público" y abrir `/ranking` y `/pantalla`.
4. En Exportar, "Descargar todo (ZIP)".

## Fase 8 · Impresión y QR

Hecho:

- **Botón Inicio** con ícono de casa, primero en el encabezado de todas las páginas.
- QR por investigación, generado en cada solicitud desde `BASE_URL` + slug y nunca guardado. Nivel Q, margen de 4 módulos, negro sobre blanco. PNG de 1200 px y SVG, con descarga (`?descargar=1`).
- **Marca «QR PROVISIONAL – NO IMPRIMIR»** si `BASE_URL` es localhost, si `url_qr_confirmada` es falsa o si la ficha no está publicada (su slug aún puede cambiar).
  - En PNG y SVG va en bandas rojas por fuera del código, así el QR provisional se puede probar.
  - En la pieza aparece como marca de agua diagonal y borde punteado.
- Pieza de medio pliego (`/admin/impresion/:id` y `/investigaciones/:id/pieza`) con la estructura del documento base:
  - Encabezado con avatar (anillo del color de la facultad), UCompensar, facultad y •••.
  - Imagen, íconos decorativos de Instagram, pregunta con acento naranja e investigadores.
  - QR de 12 cm con «Escanea y conoce la investigación».
  - Etiqueta del territorio con su color y pie institucional.
- Medidas reales en centímetros con `@page poster` de 50 × 70 cm, aplicada solo a las piezas. En pantalla se reduce con `zoom`. La barra de herramientas no se imprime.
- La barra ofrece el aviso «Imagen de referencia. Diseño sujeto a ajustes.», las instrucciones de impresión, Imprimir / Guardar como PDF, Probar QR y las descargas.
- `/admin/impresion`: estado de la URL, listado de seleccionadas y publicadas con estado del QR y verificación, lote con casillas, «Imprimir todas las publicadas» y ZIP de todos los QR (PNG + SVG + `indice.csv`).
- Vista previa del autor: QR real, enlace a la pieza y descargas. Aviso de que el QR es provisional hasta la publicación.
- `/coordinacion`: por cada ficha publicada, Probar QR, Ver pieza y Marcar QR como verificado o quitar la verificación (`qr_verificado_at`).
- Slugs nuevos de máximo 40 caracteres cortados en palabra completa (más el sufijo). Una URL más corta da módulos más grandes. Los slugs existentes no cambian.

Verificado:

- `npm run test:phase8`:
  - El PNG y el SVG **se decodifican con un lector de QR real (jsQR)** a la URL exacta.
  - Cambiar `BASE_URL` cambia el QR sin tocar la base, y no existe columna que guarde QR.
  - PNG de 1200 × 1200 sin marca y con bandas cuando es provisional; motivos de provisional correctos.
  - Contenido de la pieza, permisos (admin, autor, coordinación del programa; otros 404, sin sesión 302), lote, «todas» solo con publicadas.
  - ZIP con PNG, SVG e índice, sin archivos provisionales cuando la URL está confirmada.
  - Verificación de QR: solo publicadas y solo la coordinación del programa.
- **Criterio de aceptación (QR de 8 cm leído a 1 m):** a 1 m, la cámara de un celular (~12 MP, 70°) ve un QR de 8 cm con unos 230 px. El QR reducido a 230 px con desenfoque se lee. Con el slug más largo posible (77 caracteres), también a 180 y 150 px. La pieza usa 12 cm, con más margen. **Falta la prueba física con papel impreso y un celular.**
- Edge sin interfaz imprimió la pieza a PDF: **una página de 50,0 × 70,0 cm**.
- `npm test` completo: migraciones, navegación y fases 3 a 8.

Cómo probar:

1. Admin IMAGO → **Impresión** → «Pieza» de una ficha publicada → Imprimir / Guardar como PDF.
2. Descargar el PNG, imprimirlo a 8 cm y escanearlo con el celular desde 1 m.
3. En producción: configurar `BASE_URL` definitiva, confirmarla en Configuración y comprobar que la marca de provisional desaparece.

## Fase 9 · Despliegue y revisión final

Hecho:

- `render.yaml` (Blueprint):
  - Servicio web `postea-imago` y base `postea-db`, gratuitos y en la misma región (Virginia).
  - `npm ci`, `npm run migrate && npm start` y `healthCheckPath: /health`.
  - `NODE_VERSION=24`, `NODE_ENV=production`, `TZ=America/Bogota`.
  - `DATABASE_URL` enlazada a la base y `SESSION_SECRET` generado. `BASE_URL`, `ADMIN_*` y `ALLOWED_EMAIL_DOMAINS` los pide Render.
  - Base sin acceso externo por defecto.
- **Corrección bloqueante:** con el arranque de la especificación nunca se creaba el admin (solo lo hacía `npm run seed`). Ahora `npm start` lo crea si no existe (`src/seed-admin.js`, idempotente y seguro ante arranques simultáneos) y nunca cambia una cuenta existente.
- `.node-version` (24), `engines` `>=20.9 <25`, `.env.example` comentado y README reescrito como guía final:
  - Desarrollo local, pruebas y uso por rol.
  - Despliegue paso a paso, con el calendario del vencimiento de la base gratuita.
  - Operación durante la exhibición, respaldos con `pg_dump` y resumen de seguridad.
- Revisión de seguridad:
  - `sharp` 0.35.5: corrige vulnerabilidad alta de libvips, relevante porque procesa imágenes subidas. `npm audit`: 0 vulnerabilidades.
  - Ingreso con tiempo uniforme exista o no el correo: se compara contra un hash de relleno.
  - Límite de contraseña del restablecimiento igual al del registro (72 bytes de bcrypt).
  - Revisados todos los `<%-` de las plantillas (seguros), las consultas SQL (parametrizadas; las interpolaciones son constantes o enteros), la CSP y las redirecciones.
  - Logs de producción sin los mensajes publicitarios de `dotenv`.

Verificado:

- `npm run test:phase9`:
  - `render.yaml` cumple §10 (misma región, rama por defecto) y `.env.example` documenta todas las variables que usa el código.
  - Sin `<script>`, `style=` ni `on*=` en línea; sin escrituras a disco; encabezados de seguridad.
  - **Las 25 rutas POST rechazan peticiones sin token CSRF**, con prueba de mutación: sin la verificación, la prueba falla.
  - Admin inicial idempotente y tiempo de ingreso uniforme.
- **Ensayo de despliegue que replica Render** (Docker, sin cuenta de Render):
  - Linux con Node 24.21 y `npm ci` con `NODE_ENV=production`: 150 paquetes, sin dependencias de desarrollo, 0 vulnerabilidades.
  - PostgreSQL 16 con SSL, las 3 migraciones desde cero y el admin creado al arrancar.
  - Todas las conexiones de la app con **TLS 1.3**.
  - Encabezados HSTS, CSP, nosniff, X-Frame-Options, no-referrer; sin X-Powered-By.
  - Cookie `HttpOnly; Secure; SameSite=Lax` detrás de HTTPS, y no se emite por HTTP plano.
  - `sharp` y `bcrypt` en Linux; ficha, imagen WebP, QR (la marca se dibuja con las fuentes de Linux), pieza, ZIP de exportación y confirmación de URL sin marca.
  - Registro de visitante que vuelve a `/f/slug#invierte` con sesión.
  - Un segundo arranque, como un redeploy, no reaplica migraciones ni duplica el admin.
- `npm test` completo: migraciones, navegación y fases 3 a 9.

Pendiente (acciones tuyas):

1. Subir el código a GitHub o GitLab y crear el Blueprint en Render **entre el 1 y el 3 de octubre**. La base gratuita vence a los 30 días: si se crea el 29 de septiembre, vence durante la exhibición.
2. Cargar `BASE_URL`, `ADMIN_EMAIL` y `ADMIN_PASSWORD`, cambiar la contraseña del admin con un enlace de restablecimiento, importar programas y asignar coordinadores.
3. Confirmar la URL de los QR y hacer una prueba de impresión física (QR de 8 cm desde 1 m).
4. Revisión institucional del aviso de privacidad (versión `2026-pruebas-01`).
5. Monitor externo a `/health` cada 10 minutos del 26 al 30 de octubre y exportación diaria (ZIP).


## Ajustes posteriores · Cupo de registro e identidad UCompensar (30/09)

Hecho:

- **Cupo de registro por programa:** cada programa puede registrar máximo 3 proyectos (fichas no archivadas). Con el cupo lleno, «Crear ficha» desaparece del panel, el formulario responde 409 y el panel explica que la ampliación se solicita a IMAGO por canales internos. El autor ve el contador «X de 3 proyectos registrados».
- Admin → Programas: cupo de 1 a 100 (antes 20), sin poder bajarlo de lo ya registrado. Migración `004_cupo_programas.sql` con `CHECK (cupo BETWEEN 1 AND 100)`.
- Identidad UCompensar: logo en el encabezado, pie con logo y «Hacer para saber», tarjeta naranja en la portada (escritorio), franja institucional, símbolo en los avatares de posts y de la pieza imprimible, y logo en `/pantalla` y en el pie de la pieza.

Verificado:

- `npm run test:phase3`: con el cupo lleno no se ofrece ni se acepta otra ficha, y tres creaciones simultáneas con un solo cupo libre dejan exactamente una.
- `npm test` completo.
- Capturas en escritorio y celular de la portada, muro, ficha, ingreso, privacidad y pantalla.
- Portada: sección «Investigaciones publicadas» con las 6 más recientes y el total, visible desde la primera publicación (no espera a que un programa o territorio complete su cupo). El muro ya mostraba todo lo publicado.
- Botones de volver (ficha, formulario, vista previa, pieza, error, 404, privacidad y avisos de revisión) con recuadro morado y letras blancas. Los enlaces que no son de volver («Revisar ficha completa», PDF de SharePoint) conservan el estilo de enlace.
