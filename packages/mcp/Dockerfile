# CheguersDB MCP memory server (sidecar for Terminal-Bench / Harbor runs).
# Build from the repository root:
#   docker build -f packages/mcp/Dockerfile -t cheguers-mcp:latest .
# glibc base on purpose: the Turso native binding and onnxruntime ship glibc builds.
FROM node:22-bookworm-slim

ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true
RUN corepack enable

WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/core/package.json packages/core/package.json
COPY packages/cli/package.json packages/cli/package.json
COPY packages/benchmark/package.json packages/benchmark/package.json
COPY packages/mcp/package.json packages/mcp/package.json
RUN pnpm install --frozen-lockfile --filter "@cheguers/mcp..."

COPY packages/core/src packages/core/src
COPY packages/mcp/src packages/mcp/src
COPY packages/mcp/scripts packages/mcp/scripts

# Bake the embedding model so trials never download it (and work offline).
ARG EMBED_MODEL=Xenova/all-MiniLM-L6-v2
ARG EMBED_DIMENSIONS=384
ENV CHEGUERS_EMBED_MODEL=${EMBED_MODEL} \
    CHEGUERS_EMBED_DIMENSIONS=${EMBED_DIMENSIONS} \
    CHEGUERS_EMBED_CACHE_DIR=/models
RUN cd packages/mcp && ./node_modules/.bin/tsx scripts/prefetch-model.ts

ENV CHEGUERS_MCP_HOST=0.0.0.0 \
    CHEGUERS_MCP_PORT=8765 \
    CHEGUERS_MCP_PATH=/mcp \
    CHEGUERS_BACKEND=cheguers \
    CHEGUERS_EMBEDDER=transformers \
    CHEGUERS_EMBED_OFFLINE=true \
    CHEGUERS_DB_PATH=/data/memory.db \
    NODE_ENV=production
RUN mkdir -p /data /telemetry
VOLUME ["/data"]
EXPOSE 8765

HEALTHCHECK --interval=2s --timeout=2s --start-period=20s --retries=30 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.CHEGUERS_MCP_PORT||8765)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

WORKDIR /repo/packages/mcp
CMD ["./node_modules/.bin/tsx", "src/main.ts"]
