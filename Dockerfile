# syntax=docker/dockerfile:1
# `node:sqlite` is still experimental in Node 24 and its API may change between minors, so pin the
# version instead of tracking `24-alpine`; re-test before bumping.
FROM node:24.14-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24.14-alpine
WORKDIR /app
ENV NODE_ENV=production
# The service writes result files, audit logs and the pi auth/models files here.
RUN mkdir -p /data && chown -R node:node /data /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
COPY --chown=node:node web ./web
USER node
ENV DATA_AGENT_DATA_DIR=/data DATA_AGENT_HOST=0.0.0.0 DATA_AGENT_PORT=8787
EXPOSE 8787
# Liveness only. Readiness (a resolvable model credential) is /readyz, deliberately not wired here so
# a container that is waiting to be configured through the console is not reported as broken.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
