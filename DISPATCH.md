# Pi Native Dispatch & Resource Management

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                    User Input / TUI                          │
│  - /model>custom  (custom-provider-flow.ts)                 │
│  - /settings      (compaction thresholds)                   │
│  - /model         (model selector)                          │
└─────────┬────────────────────────────────────────┬──────────┘
          │                                        │
┌─────────▼──────────────────────────┐ ┌──────────▼───────────┐
│    Web Search Layer (web-search.ts) │ │ AI Slop Stabilizer   │
│  - DuckDuckGo / Bing / Google      │ │ (stability.ts)       │
│  - URL content fetcher             │ │ - Fabricated model detect  │
│  - Auto-provider fallback          │ │ - Hallucination check│
└─────────┬──────────────────────────┘ │ - Quality check      │
          │                            └──────────┬───────────┘
┌─────────▼──────────────────────────┐ ┌──────────▼───────────┐
│    Tool Calling Layer              │ │ API Quality Detector │
│    (tool-calling-layer.ts)         │ │ (api-quality.ts)     │
│  - Universal tool calling          │ │ - Model verification │
│  - Prompt-based fallback           │ │ - Fabricated model check   │
│  - Built-in: web_search, fetch_url │ │ - Context validation │
└─────────┬──────────────────────────┘ └──────────┬───────────┘
          │                                        │
┌─────────▼────────────────────────────────────────▼──────────┐
│              AgentSession (agent-session.ts)                 │
│  ├─ Custom Provider Flow (custom-provider-flow.ts)          │
│  ├─ Auto-Compaction Threshold (60%/80%)                     │
│  ├─ Stability Check Middleware (stability.ts)               │
│  └─ GPU Dispatcher (gpu-dispatcher.ts)                      │
└──────────────────────┬──────────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────────┐
│             pi-native (Rust CLI binary)                      │
│  ├─ detect-gpu     → GPU info (NVML, nvidia-smi, WMI)      │
│  ├─ cpu-load       → CPU load + yield advice                │
│  ├─ system-memory  → total RAM in MB                        │
│  └─ stdin/stdout   → JSON line protocol                     │
│  Binary size: 0.37 MB (target: <100 MB)                     │
└──────────────────────┬──────────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────────┐
│              LLM Providers (OpenAI, Anthropic, etc.)         │
│  ├─ Native API calls (anthropic-messages, openai-responses) │
│  ├─ OpenAI-compatible (openai-completions)                  │
│  ├─ Google AI (google-generative-ai)                        │
│  └─ Custom providers (detected from URL)                    │
└──────────────────────────────────────────────────────────────┘
```

## Files

### Rust Native Module (`packages/rust-core/`)
| File | Purpose |
|------|---------|
| `src/main.rs` | CLI binary: GPU detection, CPU load, system memory, JSON protocol |
| `Cargo.toml` | Binary config, serde_json dependency |
| `index.js` | JS bridge (spawns binary, async JSON line protocol) |
| `index.d.ts` | TypeScript types |
| `package.json` | npm package config, ESM module |

### Custom Provider Detection (`packages/ai/src/providers/`)
| File | Purpose |
|------|---------|
| `custom-provider.ts` | URL→API detection, model fetch, `createCustomProvider()` |
| `all.ts` | Re-exports from custom-provider.ts |

### Agent Layer (`packages/agent/src/harness/tools/`)
| File | Purpose |
|------|---------|
| `web-search.ts` | Web search (DuckDuckGo/Bing/Google), URL fetcher, caching |
| `api-quality.ts` | API health checks, fabricated model detection, model verification |
| `tool-calling-layer.ts` | Universal tool calling, prompt-based fallback, built-in tools |
| `stability.ts` | AI slop stabilizer: repetition, hallucination, quality checks |

### GPU Dispatcher (`packages/agent/src/`)
| File | Purpose |
|------|---------|
| `gpu-dispatcher.ts` | Parallel agent dispatch with GPU/CPU governance |

### Auto-Compaction (`packages/coding-agent/src/core/`)
| File | Purpose |
|------|---------|
| `compaction/compaction.ts` | `shouldCompact()` with percentage thresholds |
| `settings-manager.ts` | `contextThresholds` in CompactionSettings |

### TUI Integration (`packages/coding-agent/src/modes/interactive/`)
| File | Purpose |
|------|---------|
| `custom-provider-flow.ts` | `/model>custom` interactive flow |
| `interactive-mode.ts` | `/model>custom` command routing in handler |

### Tests (`packages/rust-core/test/` + `packages/agent/test/harness/`)
| File | Tests | Status |
|------|-------|--------|
| `real.test.mjs` | 15 REAL system tests | ✅ All pass |
| `detection.test.mjs` | 24 tests (20 URL detection + 4 Rust stability) | ✅ All pass |
| `smoke.test.mjs` | 5 smoke tests | ✅ All pass |
| `real-tools.test.ts` | 16 real integration tests (web-search, api-quality, tool-calling-layer, stability) | ✅ All pass |

## Resource Budget (VERIFIED on RTX 2050 / 16 cores / 32GB RAM)

| Metric | Measured | Target | Status |
|--------|----------|--------|--------|
| Binary size | 0.37 MB | < 100 MB | ✅ |
| RAM per session | 50 MB | ≤ 512 MB | ✅ |
| Max sessions (RAM) | 651 | 100 | ✅ |
| Max sessions (CPU idle) | 160 | 100 | ✅ |
| GPU VRAM | 4095 MB | > 0 | ✅ |
| Parallel GPU slots | ~8 | > 1 | ✅ |
| CPU cores | 16 | 3-4 | ✅ |

## Running

### Build Rust binary
```bash
cd packages/rust-core && cargo build --release
```

### Rust stability check
```bash
echo 'stability-check{"text":"...","modelId":"gpt-5"}' | packages/rust-core/target/release/pi-native
```

### Run tests
```bash
# Rust binary + JS bridge tests
node --test packages/rust-core/test/real.test.mjs

# URL detection tests
node --test packages/rust-core/test/detection.test.mjs

# Quick smoke test
node --test packages/rust-core/smoke.test.mjs
```

### Run custom provider flow
In TUI mode, type `/model>custom` and enter a URL.

### Deploy to Render
```bash
# Push to GitHub, connect to Render, use render.yaml
# Or build locally:
docker build -t pi-coding-agent .
```

## Custom Provider URL Detection Examples

| URL | Detected API | Confidence |
|-----|-------------|------------|
| `https://api.openai.com/v1` | openai-responses | 90% |
| `https://api.anthropic.com` | anthropic-messages | 95% |
| `https://my-resource.openai.azure.com` | azure-openai-responses | 95% |
| `https://generativelanguage.googleapis.com` | google-generative-ai | 90% |
| `https://api.mistral.ai/v1` | mistral-conversations | 85% |
| `https://api.example.com/v1/chat/completions` | openai-completions | 85% |
| `https://scnet.ai` | openai-completions | 60% |
| `https://prexzyapis.com` | openai-completions (Prexzy API) | 70% |
| `https://prexzyapis.com/ai/aichat?prompt=hello` | openai-completions (query-param) | 45% |
| `https://ergreg.burger-king.com.tr` | openai-completions (BK) | 60% |

## Auto-Compaction Behavior

Compaction triggers when context usage reaches thresholds:
- Default: 60% and 80% of context window
- Configurable via `contextThresholds` in settings
- Session automatically resumes after compaction
- Manual compaction via `/compact` command

## Safety Features

1. **CPU Governor**: Parallel dispatch yields when CPU load > 85%
2. **AI Slop Stabilizer**: Detects fabricated models, repetitions, hallucinations
3. **API Quality Detection**: Verifies models actually work before registration
4. **Graceful Degradation**: Falls back to sequential execution when resources saturated
5. **Memory Limits**: Each session limited to ~50MB RAM
