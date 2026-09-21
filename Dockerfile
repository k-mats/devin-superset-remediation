# syntax=docker/dockerfile:1

FROM node:24.21.0-bookworm-slim AS build

WORKDIR /app

# Native toolchain required to compile better-sqlite3 from source
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable

# pnpm-workspace.yaml carries the build-script allowlist and must be present
# before install so native build scripts are not ignored.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# corepack install pins the packageManager version (pnpm) inside the project
RUN corepack install && pnpm install --frozen-lockfile

COPY . .

RUN pnpm build && pnpm prune --prod

FROM node:24.21.0-bookworm-slim AS runtime

WORKDIR /app

# Runtime toolchain for independent verification (Issue #13):
# git for workspace checkouts, uv + Python 3.12 plus the Superset native
# build dependencies for `uv venv` / `uv pip install` of requirements.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       ca-certificates curl git python3 pkg-config \
       default-libmysqlclient-dev libldap2-dev libsasl2-dev \
       libffi-dev libssl-dev gcc g++ make \
    && rm -rf /var/lib/apt/lists/*

COPY --from=ghcr.io/astral-sh/uv:0.9.26 /uv /uvx /usr/local/bin/

RUN groupadd --gid 1001 app \
    && useradd --uid 1001 --gid app --create-home --home-dir /home/app app \
    && mkdir -p /app/data /opt/uv \
    && chown -R app:app /app /opt/uv /home/app

ENV UV_PYTHON_INSTALL_DIR=/opt/uv/python \
    UV_CACHE_DIR=/home/app/.cache/uv

# Pre-install the Python 3.12 interpreter used by the superset repo setup
# adapter so verification does not need a download at run time.
USER app
RUN uv python install 3.12
USER root

COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/dist ./dist
COPY --from=build --chown=app:app /app/drizzle ./drizzle
COPY --from=build --chown=app:app /app/package.json ./package.json

ENV NODE_ENV=production \
    DATABASE_PATH=/app/data/orchestrator.db

USER app

EXPOSE 3000

VOLUME ["/app/data"]

CMD ["node", "dist/index.js"]
