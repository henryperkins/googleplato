FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
COPY client/package.json ./client/package.json
COPY server/package.json ./server/package.json
COPY packages/plugin-sdk/package.json ./packages/plugin-sdk/package.json
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    if [ -f package-lock.json ]; then npm ci --no-audit --no-fund || npm install --no-audit --no-fund; else npm install --no-audit --no-fund; fi
COPY . .
RUN npm run build:client && npm prune --omit=dev --no-audit --no-fund

FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app /app
USER node
EXPOSE 3000
CMD ["node", "server/start.js"]
