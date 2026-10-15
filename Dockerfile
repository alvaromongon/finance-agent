# syntax=docker/dockerfile:1

# --- Build: compile TypeScript with every dependency ---
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npx tsc -p tsconfig.build.json

# --- Production dependencies only ---
FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

# --- Runtime: distroless, non-root ---
FROM gcr.io/distroless/nodejs22-debian13:nonroot
WORKDIR /app
ENV NODE_ENV=production \
    VAULT_PROJECT_DIR=/data
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY examples ./examples
USER nonroot
# The image runs one engine command per container, e.g.
#   docker run --rm -v "$PWD/brain:/data" --env-file .env finance-agent dist/index.js --currency EUR
# With no arguments it runs the offline demo against the example brain.
CMD ["dist/demo.js", "--currency", "EUR"]
