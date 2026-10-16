# REA Web control-plane API (and built web UI). Build context: rea-web/.
# Base images are pinned by exact version tag; pin by digest before
# production use (see deploy/README.md, "Image digests").
FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS build
WORKDIR /app
ENV HUSKY=0 NODE_ENV=development
COPY package.json package-lock.json tsconfig.base.json tsconfig.json vitest.config.ts ./
COPY packages ./packages
COPY apps ./apps
RUN npm ci --no-audit --no-fund
RUN npx tsc -b tsconfig.json \
  && npm run build -w @rea-web/web --if-present
RUN npm prune --omit=dev --no-audit --no-fund

FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d
WORKDIR /app
ENV NODE_ENV=production PORT=8080
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/packages ./packages
COPY --from=build --chown=node:node /app/apps ./apps
USER node
EXPOSE 8080
CMD ["node", "apps/api/dist/main.js"]
