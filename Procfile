# Render Procfile — pi-coding-agent with Rust native acceleration
# web: HTTP server for user-facing API and agent sessions
# worker: Background worker for heavy LLM tasks (model training, batch inference, large context processing)

web: node packages/coding-agent/dist/cli.js serve --port $PORT
worker: node packages/coding-agent/dist/cli.js worker --concurrency ${RENDER_WORKER_CONCURRENCY:-4}
