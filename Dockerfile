# Development image. It runs `pnpm dev` under hot reload, installs
# devDependencies, and does not perform a `next build`. It is meant for
# running the local-first stack on a developer's own machine via
# docker-compose.yml, not for deploying to a shared or public host. Build a
# separate production image (multi-stage `next build` + standalone output,
# no dev dependencies) before running this anywhere else.

FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

FROM base AS runner
COPY --from=deps /app/node_modules ./node_modules
COPY --chown=node:node . .
ENV NODE_ENV=development
# Run as the non-root "node" user baked into the base image rather than root.
USER node
EXPOSE 3000
CMD ["pnpm", "dev"]
