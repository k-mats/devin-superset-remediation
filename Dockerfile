FROM node:24.21.0-alpine AS build

WORKDIR /app

# Native toolchain required to compile better-sqlite3 from source
RUN apk add --no-cache python3 make g++

RUN corepack enable

# pnpm-workspace.yaml carries the build-script allowlist and must be present
# before install so native build scripts are not ignored.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

RUN corepack install && pnpm install --frozen-lockfile

COPY . .

RUN pnpm build && pnpm prune --prod

FROM node:24.21.0-alpine AS runtime

WORKDIR /app

ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/package.json ./package.json

EXPOSE 3000

CMD ["node", "dist/index.js"]
