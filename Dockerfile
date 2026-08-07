# ============================================================================
# Multi-stage Docker build for pi-coding-agent with Rust native acceleration
# ============================================================================
# Stage 1: Build the Rust binary (pi-native)
FROM rust:1.77-slim-bookworm AS rust-builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    pkg-config \
    libssl-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build
COPY packages/rust-core/ ./packages/rust-core/

RUN cargo build --release --manifest-path packages/rust-core/Cargo.toml && \
    ls -la packages/rust-core/target/release/pi-native && \
    strip packages/rust-core/target/release/pi-native

# Stage 2: Node.js app
FROM node:20-slim

# Install runtime dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files first for layer caching
COPY package.json package-lock.json ./
COPY packages/rust-core/package.json ./packages/rust-core/
COPY packages/agent/package.json ./packages/agent/
COPY packages/ai/package.json ./packages/ai/
COPY packages/coding-agent/package.json ./packages/coding-agent/

# Install dependencies
RUN npm ci --omit=dev

# Copy built Rust binary from stage 1
COPY --from=rust-builder /build/packages/rust-core/target/release/pi-native /app/packages/rust-core/target/release/pi-native
COPY --from=rust-builder /build/packages/rust-core/target/release/pi-native /usr/local/bin/pi-native

# Copy app source
COPY packages/ ./packages/

# Create health check endpoint
RUN mkdir -p /app/health
COPY <<'EOF' /app/health/index.js
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";

const PORT = process.env.PORT || 3000;
const binaryPath = process.env.PI_NATIVE_PATH || "/app/packages/rust-core/target/release/pi-native";

createServer((req, res) => {
    if (req.url === "/health") {
        // Quick test: can we run the Rust binary?
        try {
            const result = spawnSync(binaryPath, [], {
                input: "system-memory\nexit\n",
                encoding: "utf-8",
                timeout: 5000,
            });
            if (result.status === 0) {
                const mem = JSON.parse(result.stdout.trim().split("\n")[0]);
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ status: "ok", memory: mem, timestamp: new Date().toISOString() }));
            } else {
                res.writeHead(503, { "content-type": "application/json" });
                res.end(JSON.stringify({ status: "degraded", error: "binary failed" }));
            }
        } catch (err) {
            res.writeHead(503, { "content-type": "application/json" });
            res.end(JSON.stringify({ status: "error", error: err.message }));
        }
    } else {
        res.writeHead(404);
        res.end("Not found");
    }
}).listen(PORT, () => console.log(`Health server on ${PORT}`));
EOF

# Resource limits
ENV NODE_OPTIONS="--max-old-space-size=512"
ENV PI_NATIVE_PATH=/app/packages/rust-core/target/release/pi-native

# Run both health check and main app
EXPOSE 3000
CMD ["node", "--experimental-vm-modules", "packages/coding-agent/dist/index.js"]
