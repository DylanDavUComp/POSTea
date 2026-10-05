#!/usr/bin/env bash
# Respaldo de la base de Render a un archivo local (formato custom de pg_dump, restaurable con pg_restore).
#
# Uso:
#   RENDER_DATABASE_URL='postgres://…external…' scripts/backup-render.sh [carpeta]
#   scripts/backup-render.sh [carpeta]          # pide la URL sin mostrarla en pantalla
#
# - La URL es la *External Database URL* (Render → postea-db → Connect → External). Antes agrega tu IP en
#   Render → postea-db → Networking → Access Control y quítala al terminar (ver DEPLOY_RENDER.md).
# - Usa pg_dump/psql/pg_restore locales si existen; si no (o con USE_DOCKER=1), el contenedor postgres:$PG_IMAGE.
# - Verifica que pg_dump sea de la misma versión mayor que el servidor o más nueva: uno más viejo se niega a
#   respaldar o deja copias incompletas.
# - Valida que el archivo no quede vacío y que pg_restore pueda leer su índice antes de darlo por bueno.
# - La URL lleva la contraseña: nunca se imprime ni se guarda en el archivo.
set -euo pipefail

OUT_DIR=${1:-respaldos}
PG_IMAGE=${PG_IMAGE:-postgres:16.4-alpine}
URL=${RENDER_DATABASE_URL:-}
if [ -z "$URL" ]; then
  read -r -s -p "External Database URL de Render: " URL; echo
fi
case "$URL" in postgres://*|postgresql://*) ;; *) echo "ERROR: la URL debe empezar por postgres:// o postgresql://" >&2; exit 2 ;; esac
# Render exige SSL desde fuera; si la URL no trae sslmode, se pide.
case "$URL" in *sslmode=*) ;; *\?*) URL="$URL&sslmode=require" ;; *) URL="$URL?sslmode=require" ;; esac

mkdir -p "$OUT_DIR"
STAMP=$(date +%Y%m%d-%H%M%S)
FILE="$OUT_DIR/render-$STAMP.dump"

if [ "${USE_DOCKER:-0}" != "1" ] && command -v pg_dump >/dev/null && command -v psql >/dev/null && command -v pg_restore >/dev/null; then
  MODE=local
  run() { "$@"; }
  OUT_PATH="$FILE"
else
  command -v docker >/dev/null || { echo "ERROR: no hay pg_dump local ni docker." >&2; exit 2; }
  MODE="docker ($PG_IMAGE)"
  ABS_DIR=$(cd "$OUT_DIR" && { pwd -W 2>/dev/null || pwd; })
  # MSYS_NO_PATHCONV: en Git Bash para Windows evita que /r se convierta en una ruta de Windows.
  # DOCKER_NETWORK solo para probar contra una base local en contenedor; con Render no hace falta.
  run() { MSYS_NO_PATHCONV=1 docker run --rm -i ${DOCKER_NETWORK:+--network "$DOCKER_NETWORK"} -v "$ABS_DIR:/r" "$PG_IMAGE" "$@"; }
  OUT_PATH="/r/render-$STAMP.dump"
fi

# Versión mayor de pg_dump frente a la del servidor (server_version_num: 160004 → 16).
DUMP_MAJOR=$(run pg_dump --version | sed -E 's/[^0-9]*([0-9]+).*/\1/')
SERVER_NUM=$(run psql "$URL" -XtAc 'SHOW server_version_num' | tr -d '[:space:]')
SERVER_MAJOR=$((SERVER_NUM / 10000))
echo "pg_dump $DUMP_MAJOR ($MODE) · servidor PostgreSQL $SERVER_MAJOR"
if [ "$DUMP_MAJOR" -lt "$SERVER_MAJOR" ]; then
  echo "ERROR: pg_dump $DUMP_MAJOR es más viejo que el servidor ($SERVER_MAJOR). Instala pg_dump $SERVER_MAJOR o usa PG_IMAGE=postgres:$SERVER_MAJOR-alpine USE_DOCKER=1." >&2
  exit 3
fi

run pg_dump --format=custom --no-owner --no-acl --file="$OUT_PATH" "$URL"

if [ ! -s "$FILE" ]; then
  echo "ERROR: el respaldo quedó vacío ($FILE)." >&2; rm -f "$FILE"; exit 4
fi
ENTRIES=$(run pg_restore --list "$OUT_PATH" | grep -c 'TABLE DATA' || true)
if [ "$ENTRIES" -lt 1 ]; then
  echo "ERROR: pg_restore no encuentra datos de tablas en $FILE." >&2; exit 5
fi
SIZE=$(wc -c < "$FILE" | tr -d ' ')
echo "Respaldo listo: $FILE ($SIZE bytes, $ENTRIES tablas con datos)."
echo "Recuerda quitar tu IP de Render → postea-db → Networking → Access Control."
