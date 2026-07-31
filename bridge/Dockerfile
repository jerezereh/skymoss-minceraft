# better-sqlite3 is a native module, so the build stage needs a toolchain that the
# slim runtime image does not carry. Building in a separate stage keeps the compiler
# out of the final image.
FROM node:22-bookworm-slim AS build

WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

# ---------------------------------------------------------------------------

FROM node:22-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production

# Native modules built above link against libstdc++ at runtime.
RUN apt-get update && apt-get install -y --no-install-recommends \
      libstdc++6 tini \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
COPY migrations ./migrations
COPY src ./src

# The DB lives on a mounted volume, not in the image.
RUN mkdir -p /data && chown -R node:node /data /app
USER node

EXPOSE 3000

# tini reaps zombies and forwards signals, so SIGTERM reaches Node and the graceful
# shutdown path actually runs instead of the container being killed.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--experimental-strip-types", "src/index.ts"]
