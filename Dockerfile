FROM node:22-bookworm-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM base AS build
COPY package.json package-lock.json ./
RUN npm ci --include=dev --ignore-scripts
COPY prisma.config.ts tsconfig.json ./
COPY prisma/schema.prisma ./prisma/schema.prisma
COPY scripts/prisma/generate.mjs ./scripts/prisma/generate.mjs
COPY server/tsconfig.json ./server/tsconfig.json
COPY server/src ./server/src
COPY scripts/stocks-deploy/healthcheck*.mjs ./scripts/stocks-deploy/
# The generation shim uses a dummy URL; building never connects to a database.
RUN npm run prisma:generate && npm run build:server && node --test scripts/stocks-deploy/healthcheck.test.mjs
RUN npm prune --omit=dev --ignore-scripts

FROM base AS runtime
ENV NODE_ENV=production PORT=8080 STOCKS_MODE=DISABLED STOCKS_AUTODISPATCH=0
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/server/dist ./server/dist
COPY --chown=node:node package.json ./package.json
COPY --chown=node:node prisma/migrations ./prisma/migrations
COPY --chown=node:node scripts/stocks-preflight ./scripts/stocks-preflight
COPY --chown=node:node scripts/stocks-deploy/healthcheck.mjs ./scripts/stocks-deploy/healthcheck.mjs
# Public legacy registry, plus the ArcoUSD registry once its deploy script has written it (the
# [n] glob keeps the build working before then; the API stays "not-deployed" without it).
# Reviewed Stocks settings are mounted at runtime.
COPY --chown=node:node deployments/91342/arco-giwa-preprod.json deployments/91342/arcousd-giwa.jso[n] ./deployments/91342/
USER node
EXPOSE 8080
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD ["node", "scripts/stocks-deploy/healthcheck.mjs"]
CMD ["node", "server/dist/index.js"]
