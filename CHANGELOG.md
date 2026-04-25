# Changelog

All notable changes to FreeRouter are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

### Added
- **Hot-reload providers**: `router.addProvider()` and `router.removeProvider()` let you add or remove LLM providers at runtime with graceful in-flight request draining and zero data loss
- **Hot-reload models**: `router.addModel()` and `router.removeModel()` manage per-model availability and pricing at runtime
- **Lifecycle events**: `router.on('provider:added' | 'provider:removed' | 'model:added' | 'model:removed', handler)` for observing provider/model changes
- **Plugin system**: `router.use(plugin)` installs reusable `FreeRouterPlugin` extensions; duplicate installs are silently skipped
- **Config validator**: `validateConfig(config)` returns structured `{ valid, errors, warnings }` — replaces the silent unknown-key warning
- **Health API**: `router.healthCheck()` returns provider availability, uptime, and overall status (`healthy | degraded | unhealthy`)
- **Metrics API**: `router.metrics()` returns request counts, latency percentiles (p50/p95/p99), error rate, spend totals, and per-provider breakdowns
- **OpenAI-compatible middleware**: `createMiddleware(router)` from `freerouter/adapters` mounts FreeRouter as an OpenAI-compatible `POST /v1/chat/completions` handler for Express and Fastify
- **Redis key store**: `RedisKeyStore` from `freerouter/adapters` — drop-in replacement for the in-memory key store for multi-instance deployments
- **Redis rate limiter**: `RedisRateLimiter` from `freerouter/adapters` — distributed token-bucket rate limiter using atomic Lua scripts
- **CLI**: `freerouter` binary with `validate-config`, `list-providers`, and `rotate-key` commands
- **New type exports**: `ModelPricingEntry`, `RouterEventMap`, `ProviderLifecycleEvent`, `ModelLifecycleEvent`, `HealthStatus`, `RouterMetrics`, `LatencyBuckets`, `ProviderHealth`, `RateLimiterLike`, `StoredKey`
- **New audit actions**: `provider:added`, `provider:removed`, `model:added`, `model:removed`

### Changed
- `RateLimiter` now implements the exported `RateLimiterLike` interface — custom rate limiters can be swapped in
- `StoredKey` is now an exported interface from `freerouter/security` — enables custom key store implementations
- `buildRecord` / `buildStreamRecord` in router prefer runtime pricing overrides (registered via `addModel`) over provider defaults

## [0.1.0] — Initial release

- Zero-dependency TypeScript LLM router
- Five built-in providers: Google Gemini, OpenAI, Anthropic, Mistral, Groq
- AES-256-GCM BYOK key encryption with zero-fill buffers
- Hierarchical FinOps budgets (global → org → dept → team → user)
- Spend tracking, forecasting, and chargeback reporting
- HMAC-SHA256 request signing
- Prompt injection guard (14+ patterns, Unicode normalization)
- JSON/YAML/TOML config file loading
- Native streaming via `AsyncGenerator`
