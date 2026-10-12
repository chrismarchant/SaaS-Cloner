# REA Web Linux runner. Build context: repository root (upstream REA + rea-web).
# Includes the unchanged upstream REA build and the bring-your-own tools that
# preservation collectors use. Provider engines (Ghidra, Hopper, IDA, JADX,
# Binwalk, Unblob, pwntools, WABT, Chromium) are NOT installed; their tools
# remain unavailable and upstream reports why.
FROM node:24.18.0-bookworm AS build
ENV HUSKY=0
WORKDIR /opt/rea
COPY . .
RUN npm ci --no-audit --no-fund && npm run build:cached
WORKDIR /opt/rea/rea-web
RUN npm ci --no-audit --no-fund && npx tsc -b tsconfig.json && npm prune --omit=dev --no-audit --no-fund

FROM node:24.18.0-bookworm-slim
# git + git-lfs: source collector; python3: Code-to-PRD; postgresql-client-18
# (matches the PostgreSQL 18 image Railway provisions) from the PGDG apt repo so pg_dump is never older than
# the server it captures; ca-certificates for outbound HTTPS to the API.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl gnupg git git-lfs python3 \
  && install -d /usr/share/postgresql-common/pgdg \
  && curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc \
  && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends postgresql-client-18 \
  && apt-get purge -y curl gnupg \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production REA_WEB_REA_ROOT=/opt/rea
COPY --from=build --chown=node:node /opt/rea /opt/rea
USER node
WORKDIR /home/node
RUN mkdir -p /home/node/rea-web-workspace
CMD ["node", "/opt/rea/rea-web/apps/runner/dist/main.js"]
