# ==============================================================================
# Build Stage
#
# This stage installs all dependencies (including dev), builds the TypeScript
# source code into JavaScript, and prepares the production assets.
#
# Pinned to BUILDPLATFORM, not the target platform. `bun run build` emits
# platform-independent JavaScript and only `dist/` is copied forward, so this
# stage has no reason to run under emulation — and under QEMU it does not run
# at all: Bun's JavaScriptCore aborts with a spurious MemoryExhaustion
# assertion (~21 MB peak), so a cross-arch build of this stage fails outright
# on an arm64 host. Building natively also removes emulation from the slowest
# stage of a multi-arch build.
# ==============================================================================
FROM --platform=$BUILDPLATFORM oven/bun:1.4.0 AS build

WORKDIR /usr/src/app

# Copy dependency manifests for optimized layer caching
COPY package.json bun.lock ./

# Install all dependencies (including dev dependencies for building).
# The BuildKit cache mount persists Bun's global package cache across builds.
# --ignore-scripts: the build only runs tsc, which needs type declarations, not
# compiled bindings. DuckDB ships prebuilt os/cpu-gated binding packages, so no
# native postinstall is needed here.
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile --ignore-scripts

# Copy the rest of the source code
COPY . .

# Build the application
RUN bun run build


# ==============================================================================
# Production Stage
#
# This stage creates a minimal, optimized, and secure image for running the
# application. It uses a slim base image and only includes production
# dependencies and build artifacts.
# ==============================================================================
FROM oven/bun:1.4.0-slim AS production

WORKDIR /usr/src/app

# Set the environment to production for performance and to ensure only
# production dependencies are installed.
ENV NODE_ENV=production

# OCI image metadata (https://github.com/opencontainers/image-spec/blob/main/annotations.md)
ARG APP_VERSION=dev
LABEL org.opencontainers.image.title="@cyanheads/brapi-mcp-server"
LABEL org.opencontainers.image.description="BrAPI v2.1 MCP server — studies, germplasm, observations, genotypes, images, and pedigrees across Breedbase, T3, Sweetpotatobase, and any BrAPI-compliant server."
LABEL org.opencontainers.image.source="https://github.com/cyanheads/brapi-mcp-server"
LABEL org.opencontainers.image.licenses="Apache-2.0"
LABEL org.opencontainers.image.version="${APP_VERSION}"

# Copy dependency manifests
COPY package.json bun.lock ./

# Install only production dependencies, ignoring any lifecycle scripts (like 'prepare')
# that are not needed in the final production image.
# `--omit=peer` drops the framework's optional peer tiers (test runner, service
# SDKs, parsers) that Bun would otherwise auto-install. Anything this server
# actually imports belongs in its own `dependencies` — @duckdb/node-api among
# them — so nothing needed at runtime is lost. The two `bun add` steps below
# carry the same flag; without it, they re-resolve the graph and pull every
# optional peer back in.
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --production --omit=peer --frozen-lockfile --ignore-scripts

# Conditionally install OpenTelemetry optional peer dependencies (Tier 3).
# These are not bundled by default to keep the base image lean. Enable at build time
# with: docker build --build-arg OTEL_ENABLED=true
ARG OTEL_ENABLED=true
RUN --mount=type=cache,target=/root/.bun/install/cache \
    if [ "$OTEL_ENABLED" = "true" ]; then \
      bun add --omit=dev --omit=peer --ignore-scripts @hono/otel \
        @opentelemetry/instrumentation-http \
        @opentelemetry/exporter-metrics-otlp-http \
        @opentelemetry/exporter-trace-otlp-http \
        @opentelemetry/instrumentation-pino \
        @opentelemetry/resources \
        @opentelemetry/sdk-metrics \
        @opentelemetry/sdk-node \
        @opentelemetry/sdk-trace-node \
        @opentelemetry/semantic-conventions; \
    fi

# Conditionally install the DuckDB optional peer dependency for the dataframe
# (canvas) surface. Default-on so the published image works out of the box with
# CANVAS_PROVIDER_TYPE=duckdb. Disable for size-sensitive self-builds with:
#   docker build --build-arg CANVAS_ENABLED=false
ARG CANVAS_ENABLED=true
RUN --mount=type=cache,target=/root/.bun/install/cache \
    if [ "$CANVAS_ENABLED" = "true" ]; then \
      bun add --omit=dev --omit=peer @duckdb/node-api; \
    fi

# Copy the compiled application code from the build stage
COPY --from=build /usr/src/app/dist ./dist

# The 'oven/bun' image already provides a non-root user named 'bun'.
# We will use this existing user for enhanced security.

# Create and set permissions for the log directory, assigning ownership to the 'bun' user.
RUN mkdir -p /var/log/brapi-mcp-server && chown -R bun:bun /var/log/brapi-mcp-server

# Switch to the non-root user
USER bun

# Define an argument for the port, allowing it to be overridden at build time.
# The `PORT` variable is often injected by cloud environments at runtime.
ARG PORT

# Set runtime environment variables
# Note: PORT is an automatic variable in many cloud environments (e.g., Cloud Run)
ENV MCP_HTTP_PORT=${PORT:-3010}
ENV MCP_HTTP_HOST="0.0.0.0"
ENV MCP_TRANSPORT_TYPE="http"
ENV MCP_SESSION_MODE="stateful"
ENV MCP_LOG_LEVEL="info"
ENV LOGS_DIR="/var/log/brapi-mcp-server"
ENV MCP_FORCE_CONSOLE_LOGGING="true"

# Expose the port the server listens on
EXPOSE ${MCP_HTTP_PORT}

# Health check — hits the framework's /healthz endpoint using a bun-native
# fetch (the slim image ships no curl/wget).
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD bun -e "fetch('http://localhost:'+(process.env.MCP_HTTP_PORT??'3010')+'/healthz').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# The command to start the server
CMD ["bun", "run", "dist/index.js"]
