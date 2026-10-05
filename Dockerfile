# syntax=docker/dockerfile:1
# Imagen de producción de POSTEA (Render: Web Service, runtime Docker). Funciona sola, sin compose.

# --- Dependencias de producción ---
# Debian slim (glibc): sharp y bcrypt traen binarios precompilados, sin compiladores en la imagen.
FROM node:24-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# --- Imagen final ---
FROM node:24-bookworm-slim
ENV NODE_ENV=production \
    TZ=America/Bogota \
    PORT=10000 \
    # 512 MB en el plan gratuito: heap acotado y menos arenas de malloc para libvips (sharp).
    NODE_OPTIONS=--max-old-space-size=320 \
    MALLOC_ARENA_MAX=2
WORKDIR /app
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public
COPY --chown=node:node migrations ./migrations
COPY --chown=node:node scripts/migrate.js ./scripts/migrate.js
USER node
EXPOSE 10000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||10000)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
# Migraciones idempotentes (schema_migrations + advisory lock) y luego el servidor en 0.0.0.0:$PORT.
# exec: Node recibe SIGTERM directamente y Render puede detenerlo limpio.
CMD ["sh", "-c", "node scripts/migrate.js && exec node src/server.js"]
