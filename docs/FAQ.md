# FreeRouter — Frequently Asked Questions

---

## Table of Contents

1. [What is FreeRouter?](#1-what-is-freerouter)
2. [Core Concepts](#2-core-concepts)
3. [Feature Reference](#3-feature-reference)
4. [How to Use FreeRouter](#4-how-to-use-freerouter)
5. [Deployment Guide with Examples](#5-deployment-guide-with-examples)
6. [Enterprise Use Cases](#6-enterprise-use-cases)
7. [Troubleshooting](#7-troubleshooting)

---

## 1. What is FreeRouter?

### What problem does FreeRouter solve?

Most enterprises that want to offer LLM capabilities to internal teams or end customers face three hard problems simultaneously:

- **Key security** — user API keys for OpenAI, Anthropic, Google etc. must never be logged, stored plaintext, or leaked across user boundaries.
- **Cost control** — without guardrails, a single power user or runaway loop can exhaust the entire month's LLM budget in minutes.
- **Multi-provider flexibility** — models change rapidly; you need to swap providers, add new ones, or fall back to cheaper alternatives without redeploying.

FreeRouter solves all three in a single embeddable TypeScript library with zero runtime dependencies.

### Who is FreeRouter for?

- **Platform teams** building internal developer portals, AI assistants, or copilots where employees bring their own LLM API keys.
- **SaaS companies** offering LLM-powered features to customers who provide their own keys (BYOK — Bring Your Own Key).
- **Enterprise architects** who need hierarchical spend governance (org → department → team → user) and ERP-ready chargeback reporting.
- **Security-conscious teams** who require AES-256-GCM key encryption at rest, HMAC-signed requests, and prompt-injection defence.

### What does "zero runtime dependency" mean?

FreeRouter has no `npm` package dependencies in its production bundle — not even `axios`, `zod`, or `winston`. Everything from HTTP to cryptography uses Node.js built-ins (`crypto`, `https`, `fs/promises`). This means:

- No transitive dependency CVEs.
- Smallest possible bundle (< 50 KB).
- No supply-chain risk from third-party packages.

The only *optional* peer dependency is `redis` (for the distributed `RedisKeyStore` and `RedisRateLimiter` adapters), which you only install if you need it.

### What providers does FreeRouter support?

Out of the box: **Google Gemini**, **OpenAI (GPT-4, o3, o4)**, **Anthropic (Claude)**, **Mistral**, **Groq (Llama, Gemma)**.

All providers are lazy-loaded — only instantiated the first time a request is routed to them. You can also register fully custom providers by implementing the `BaseProvider` interface.

Chinese-origin models (DeepSeek, Qwen, Zhipu, etc.) are blocked by the default registry policy and cannot be registered.

---

## 2. Core Concepts

### What is BYOK (Bring Your Own Key)?

In a BYOK architecture, each user provides their own API key for the LLM provider of their choice. FreeRouter stores these keys encrypted with AES-256-GCM, derives a unique encryption key per user from a master key you control, and injects the plaintext API key into the outbound HTTP request for only the microseconds needed to transmit it — then immediately zeros the buffer.

No key ever touches a log, a database row, or a response body.

### What is the budget hierarchy?

FreeRouter enforces spending at five nested scopes:

```
global
  └─ org (e.g. "acme-corp")
       └─ department (e.g. "product")
            └─ team (e.g. "growth-engineering")
                 └─ user (e.g. "alice@acme.com")
```

Every request is checked against *all* applicable scopes before being sent. A policy at any tier can block, throttle, warn, or downgrade the request to a cheaper model. Higher-priority policies are evaluated first.

### What budget windows are supported?

`hourly`, `daily`, `weekly`, `monthly`, `quarterly`, and `total` (unlimited window, useful for project caps).

### What happens when a budget is exceeded?

You choose the behaviour per policy via `onLimitReached`:

| Value | Effect |
|---|---|
| `block` | Request is rejected before the provider is called. |
| `throttle` | Same as block — intended to signal a backoff to callers. |
| `downgrade` | Request is re-routed to a cheaper `fallbackModel`. |
| `warn` | Request proceeds; a warning is added to `PolicyDecision.warnings`. |
| `notify` | Same as warn — intended for external alerting integration. |

### What is the SpendStore?

In its default configuration, FreeRouter keeps spend records in memory. The `SpendStore` interface lets you persist those records to disk (via `FileSpendStore`), Redis, a database, or any backend you choose. Records are restored on startup via `router.init()` so budget counters survive restarts.

### What is the PricingSource?

A `PricingSource` is a pluggable adapter that provides current model pricing and provider-declared rate-limit caps (`rpmLimit`, `tpmLimit`). FreeRouter ships `HttpPricingSource` (fetches a JSON endpoint), `FilePricingSource` (reads a local file, re-reads on every call for hot-swapping), and `StaticPricingSource` (in-memory, for tests).

### What is the CostRouter?

The `CostRouter` is a sub-millisecond, zero-I/O component that selects the cheapest model from a configured candidate list before the request is sent. It is purely arithmetic — it reads the provider's pricing from the in-memory registry and picks the lowest-input-cost model. It can be restricted to batch-priority requests only (`batchOnly: true`).

### What is the RulesEngine?

The `RulesEngine` lets the admin express *value-based* directives that override pure cost optimization. Rules match on user/org/team/department/metadata/priority/model glob and emit one of three actions: **pin** a specific model, override the cost-router **strategy**, or **block** the request. Rules run *before* the CostRouter and *before* policy/budget evaluation. Three modes (`pin-wins`, `narrow-candidates`, `post-override`) control how a matched rule interacts with cost optimization. Rules can be authored programmatically in `config.rules` or hot-reloaded from JSON via `FileRulesSource`. Each matched request carries the `ruleId` into the audit trail.

---

## 3. Feature Reference

### Security

| Feature | Detail |
|---|---|
| AES-256-GCM key encryption | Each user key is encrypted at rest; the plaintext is only in memory during the outbound HTTP request. |
| Per-user key derivation | A unique AES key is derived from your master key per `(userId, provider)` pair via HKDF. |
| Key expiry | Set `keyExpiryMs` to automatically reject keys older than a given TTL. |
| HMAC-SHA256 request signing | Enable `requestSigning: true` to attach an HMAC digest to every request for replay-detection. |
| Prompt injection guard | 14+ regex patterns block common injection strings (`ignore all previous instructions`, jailbreak terms, etc.). |
| Unicode normalization | All input is NFKD-normalized before injection scanning to defeat homoglyph attacks. |
| Input length limit | Configurable `maxInputLength` (default 100 000 chars) prevents runaway prompt stuffing. |
| Model allowlist | `allowedModels` rejects any model not in the list before the request leaves your process. |
| Provider blocklist | `blockedProviders` prevents registration of specific providers at the registry level. |
| Admin model block/unblock | `router.blockModel()` / `unblockModel()` for runtime compliance holds — reversible, preserves pricing history. |

### FinOps

| Feature | Detail |
|---|---|
| Hierarchical budget cascade | `global → org → dept → team → user`, all evaluated pre-flight. |
| Per-model spend caps | `BudgetPolicy.modelCaps` restricts spend on specific model prefixes within a policy. |
| Alert thresholds | `alertThresholds: [50, 80, 95]` fires `budget:warning` events at % milestones, de-duplicated per policy. |
| Burn-rate forecasting | `SpendForecaster` projects end-of-window spend using current hourly burn rate; returns `on-track`, `at-risk`, or `over-budget`. |
| ERP-ready chargeback | `ChargebackEngine.generateReport()` returns breakdowns by provider, model, user, team, and department for any date range. |
| Spend persistence | `FileSpendStore` (atomic JSON) or custom `SpendStore`. Records survive restarts and are loaded via `router.init()`. |
| Scheduled flush | `spendPersistence.intervalMs` auto-flushes on a timer (timer is `unref()`'d to not block process exit). |
| Graceful shutdown flush | `router.shutdown()` always flushes before clearing timers. `autoFlushOnExit: true` registers SIGINT/SIGTERM handlers. |
| Token-bucket rate limiting | `RateLimiter` with configurable `requestsPerMinute`, `tokensPerMinute`, and `burstAllowance`. |
| Distributed rate limiting | `RedisRateLimiter` for multi-process / multi-instance deployments. |
| Variable cost optimization | `CostRouter` selects the cheapest candidate model (strategies: `cheapest`, `balanced`, `performance`). |
| Batch priority flag | `ChatRequest.priority: 'batch'` marks non-latency-sensitive requests eligible for cost routing. |
| Cache-aware cost calculation | `TokenUsage.cachedPromptTokens` + `ModelPricingEntry.cachedInput` — actual cost reflects provider cache discounts. |
| Live pricing refresh | `HttpPricingSource` / `FilePricingSource` + `pricingRefresh.intervalMs` keep rates current without restarts. |
| Manual pricing override | `router.setPricingOverride(provider, model, pricing)` for runtime adjustments. |
| Admin rules engine | Match on user/org/team/dept/metadata/model glob → pin a model, override strategy, or block. Three modes: `pin-wins`, `narrow-candidates`, `post-override`. |
| Hot-reloadable rules | `FileRulesSource` polls JSON on disk; `router.refreshRules()`, `setRule()`, `removeRule()`, `listRules()` for runtime control. |
| Audit trail integration | Matched rules carry their `ruleId` into every `request:sent` and `request:blocked` audit entry. |

### Observability

| Feature | Detail |
|---|---|
| Structured audit trail | Every key operation, request, block, and budget event produces a typed `AuditEntry`. Plug any sink via `AuditSink`. |
| Health check | `router.healthCheck()` returns `healthy` / `degraded` / `unhealthy` with per-provider availability. |
| Router metrics | `router.metrics()` returns request counts (total / succeeded / failed / blocked), p50/p95/p99 latency, error rate, and per-provider spend. |
| Lifecycle events | Subscribe to `provider:added`, `provider:removed`, `model:added`, `model:removed` via `router.on()`. |
| Budget hooks | `onBudgetWarning`, `onBudgetExceeded`, `onForecastAtRisk`, `onRequestComplete` for real-time alerting integration. |
| Pricing refresh hook | `onPricingRefreshed(count)` fires after each successful pricing manifest fetch. |

### Extensibility

| Feature | Detail |
|---|---|
| Plugin system | `router.use(plugin)` installs named plugins (deduplicated); plugins call the public router API. |
| Custom providers | Implement `BaseProvider` and call `router.registerProvider()`. |
| Hot-reload providers | `router.addProvider()` / `removeProvider()` at runtime with in-flight request drain. |
| Hot-reload models | `router.addModel()` / `removeModel()` without restarting. |
| Custom key store | Implement `KeyStore` to back the key manager with Redis, Vault, or any KMS. |
| Custom rate limiter | Implement `RateLimiterLike` to plug in your own rate limiting logic. |
| Custom spend store | Implement `SpendStore` for any persistence backend. |
| Custom pricing source | Implement `PricingSource` to fetch rates from any source (database, config service, etc.). |
| OpenAI-compatible middleware | `createMiddleware(router)` wraps FreeRouter in an Express/Fastify handler that speaks the OpenAI Chat API wire format. |
| Config file | `FreeRouter.fromFile('./freerouter.config.json')` accepts JSON, YAML, or TOML. |
| CLI | `freerouter validate-config`, `list-providers`, `rotate-key` for operational management. |

---

## 4. How to Use FreeRouter

### Installation

```bash
npm install freerouter
# Optional: for distributed adapters
npm install redis
```

### Minimal setup

```typescript
import { FreeRouter } from 'freerouter'

const router = new FreeRouter({
  masterKey: process.env.ROUTER_MASTER_KEY, // 32-byte hex string
  audit: { enabled: true },
})

// Register a user's key (encrypted immediately)
router.setKey('alice', 'openai', process.env.ALICE_OPENAI_KEY!)

// Route a request
const response = await router.chat('alice', {
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'Summarise this PR in three bullets.' }],
})

console.log(response.content)
console.log(`Cost: $${response.usage}`)
```

### From a config file

```typescript
// Loads from file, calls router.init() automatically
const router = await FreeRouter.fromFile('./freerouter.config.json')
```

```json
{
  "defaultProvider": "openai",
  "promptInjectionGuard": true,
  "audit": { "enabled": true },
  "rateLimit": { "requestsPerMinute": 60, "tokensPerMinute": 100000 },
  "budgets": [
    {
      "id": "org-monthly",
      "scope": { "type": "org", "orgId": "acme" },
      "window": "monthly",
      "maxSpendUsd": 2000,
      "onLimitReached": "warn",
      "alertThresholds": [50, 80, 95]
    }
  ]
}
```

### Streaming responses

```typescript
const stream = router.chatStream('alice', {
  model: 'claude-3-5-sonnet-20241022',
  messages: [{ role: 'user', content: 'Write a design doc for a rate limiter.' }],
})

for await (const chunk of stream) {
  process.stdout.write(chunk.delta)
  if (chunk.done && chunk.usage) {
    console.log(`\nTokens: ${chunk.usage.totalTokens}`)
  }
}
```

### Spend persistence across restarts

```typescript
import { FreeRouter } from 'freerouter'
import { FileSpendStore } from 'freerouter/adapters'

const router = new FreeRouter({
  masterKey: process.env.ROUTER_MASTER_KEY!,
  spendPersistence: {
    store: new FileSpendStore('./data/spend.json'),
    intervalMs: 60_000,      // auto-flush every minute
    autoFlushOnExit: true,   // flush on SIGINT / SIGTERM (default: true)
  },
})

await router.init() // loads historical spend from disk
```

### Live pricing refresh

```typescript
import { FilePricingSource } from 'freerouter/adapters'

const router = new FreeRouter({
  masterKey: process.env.ROUTER_MASTER_KEY!,
  pricingRefresh: {
    source: new FilePricingSource('./config/pricing.json'),
    intervalMs: 300_000, // re-read file every 5 minutes
  },
  onPricingRefreshed: (n) => console.log(`Pricing updated: ${n} models`),
})

await router.init()
```

**`pricing.json`** — edit this file and changes are reflected on the next refresh cycle, no restart needed:

```json
{
  "openai": {
    "gpt-4o":      { "input": 2.50, "output": 10.0, "cachedInput": 1.25, "rpmLimit": 500 },
    "gpt-4o-mini": { "input": 0.15, "output": 0.60, "cachedInput": 0.075 }
  },
  "anthropic": {
    "claude-3-5-sonnet-20241022": { "input": 3.0, "output": 15.0, "cachedInput": 0.30 }
  }
}
```

### Cost optimization for batch jobs

```typescript
const router = new FreeRouter({
  masterKey: process.env.ROUTER_MASTER_KEY!,
  costOptimization: {
    strategy: 'cheapest',
    candidateModels: ['gpt-4o-mini', 'gemini-2.0-flash-lite'],
    minCostThresholdUsd: 0.001, // skip for tiny requests
    batchOnly: true,            // only optimize non-realtime traffic
  },
})

// Realtime assistant response — uses the requested model as-is
await router.chat('alice', {
  model: 'gpt-4o',
  priority: 'realtime',
  messages: [{ role: 'user', content: 'Quick question...' }],
})

// Nightly summarisation job — automatically routed to cheapest candidate
await router.chat('alice', {
  model: 'gpt-4o',
  priority: 'batch',
  messages: [{ role: 'user', content: 'Summarise these 500 tickets...' }],
})
```

### Admin rules engine — value-based overrides

When pure cost minimization is the wrong answer (legal must use Sonnet; VIP customers must never be downgraded; contractors must be blocked from frontier models), express it declaratively with rules.

```typescript
import { FreeRouter, FileRulesSource } from 'freerouter'

const router = new FreeRouter({
  costOptimization: {
    strategy: 'cheapest',
    candidateModels: ['gemini-2.0-flash-lite', 'gpt-4o-mini'],
  },
  rules: {
    mode: 'pin-wins',  // 'pin-wins' | 'narrow-candidates' | 'post-override'
    rules: [
      // Legal team: quality over cost
      { id: 'legal-quality', priority: 100,
        match: { teamId: 'legal' },
        action: { type: 'pin', model: 'anthropic/claude-3-5-sonnet-20241022' } },

      // Code-review use case → never downgrade
      { id: 'code-review',
        match: { metadata: { useCase: 'code-review' } },
        action: { type: 'strategy', strategy: 'performance' } },

      // Contractors blocked from frontier models
      { id: 'no-contractors',
        match: { orgId: 'contractors', modelPattern: 'openai/gpt-4o' },
        action: { type: 'block', reason: 'Frontier models restricted to employees' } },
    ],
  },
})

// Match metadata is propagated through to the audit entry as `ruleId`
await router.chat('alice',
  { model: 'gemini-2.0-flash', messages, metadata: { useCase: 'code-review' } },
  { teamId: 'legal' }
)
```

**Hot-reloadable rules from a JSON file:**

```typescript
new FreeRouter({
  rules: { mode: 'pin-wins', rules: [] },
  rulesRefresh: {
    source: new FileRulesSource('./config/rules.json'),
    intervalMs: 60_000, // poll every minute, or omit for manual refresh
  },
  onRulesRefreshed: count => console.log(`Loaded ${count} rules`),
})

// Or push rules at runtime:
router.setRule({ id: 'vip-alice', match: { userId: 'alice' },
                 action: { type: 'strategy', strategy: 'performance' } })
router.removeRule('vip-alice')
await router.refreshRules()
```

**Mode semantics:**

| Mode                | Pin behavior                                           | Best for                                                 |
| ------------------- | ------------------------------------------------------ | -------------------------------------------------------- |
| `pin-wins`          | Pinned model used directly; cost router bypassed.      | Hard overrides (legal, compliance, VIP).                 |
| `narrow-candidates` | Cost router runs with `[pinned]` as the only choice.   | "Use this model **if pricing makes sense**".             |
| `post-override`     | Cost router runs, then pin replaces the result.        | Audit trail of what cost router *would have* picked.     |

Rules run **before** cost optimization and **before** policy/budget evaluation. Each matched request's `ruleId` is written into the audit trail.

### Admin model blocking

```typescript
// Compliance hold — block a model immediately
router.blockModel('openai', 'gpt-4o')

// Lift the hold when cleared
router.unblockModel('openai', 'gpt-4o')

// Permanent removal (also removes pricing entry)
router.removeModel('openai', 'gpt-4o')
```

### Querying spend and generating chargeback reports

```typescript
// Current month's spend for a team
const summary = router.getSpend(
  { type: 'team', orgId: 'acme', teamId: 'growth' },
  'monthly'
)
console.log(`$${summary.spendUsd.toFixed(2)} of ${summary.requests} requests`)

// Burn-rate forecast
const forecast = router.getForecast(
  { type: 'org', orgId: 'acme' },
  'monthly',
  2000 // budget USD
)
// forecast.recommendation: 'on-track' | 'at-risk' | 'over-budget'
// forecast.estimatedBudgetExhaustionAt: epoch ms

// ERP chargeback report for April 2026
const report = router.getChargebackReport(
  { type: 'org', orgId: 'acme' },
  new Date('2026-04-01'),
  new Date('2026-04-30')
)
// report.byTeam, report.byDepartment, report.byUser, report.byModel, report.byProvider
```

---

## 5. Deployment Guide with Examples

### Pattern A — Single-process Node.js service (most common)

The simplest production deployment: one Node.js process, `FileSpendStore` for persistence, `FilePricingSource` for live pricing.

```
your-api-server.ts
  └─ FreeRouter instance (singleton, shared)
       ├─ FileSpendStore → /data/spend.json
       └─ FilePricingSource → /config/pricing.json
```

```typescript
// server.ts
import express from 'express'
import { FreeRouter } from 'freerouter'
import { createMiddleware } from 'freerouter/adapters'
import { FileSpendStore, FilePricingSource } from 'freerouter/adapters'

const router = new FreeRouter({
  masterKey: process.env.ROUTER_MASTER_KEY!,
  promptInjectionGuard: true,
  audit: { enabled: true },
  spendPersistence: {
    store: new FileSpendStore('/data/spend.json'),
    intervalMs: 60_000,
    autoFlushOnExit: true,
  },
  pricingRefresh: {
    source: new FilePricingSource('/config/pricing.json'),
    intervalMs: 300_000,
  },
  budgets: [
    {
      id: 'global-daily',
      scope: { type: 'global' },
      window: 'daily',
      maxSpendUsd: 500,
      onLimitReached: 'block',
      alertThresholds: [75, 90],
    },
  ],
})

await router.init()

const app = express()
app.use(express.json())

// OpenAI-compatible endpoint — works with any client that speaks OpenAI Chat API
app.use('/v1', createMiddleware(router, {
  extractUserId: (req) => req.headers['x-user-id'] as string ?? 'anonymous',
}))

app.listen(3000)
```

**Docker:**

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
RUN npm run build
VOLUME ["/data"]
CMD ["node", "dist/server.js"]
```

### Pattern B — Multi-instance deployment with Redis

For horizontally-scaled deployments (multiple pods/processes), use Redis adapters so spend tracking, rate limiting, and key storage are shared.

```
pod-1            pod-2           pod-3
FreeRouter       FreeRouter      FreeRouter
     \               |               /
      \──────── Redis cluster ───────/
                     |
               spend-store (custom)
               rate-limiter (RedisRateLimiter)
               key-store (RedisKeyStore)
```

```typescript
import { FreeRouter } from 'freerouter'
import { RedisKeyStore, RedisRateLimiter } from 'freerouter/adapters'
import { createClient } from 'redis'

const redis = createClient({ url: process.env.REDIS_URL })
await redis.connect()

const router = new FreeRouter({
  masterKey: process.env.ROUTER_MASTER_KEY!,
  rateLimit: { requestsPerMinute: 120, tokensPerMinute: 200_000 },
  pricingRefresh: {
    source: new HttpPricingSource(process.env.PRICING_URL!, {
      bearerToken: process.env.PRICING_TOKEN,
    }),
    intervalMs: 3_600_000, // hourly
  },
})

// Swap default key manager store with Redis
const keyManager = (router as any).keyManager
keyManager.store = new RedisKeyStore(redis, { prefix: 'fr:keys:' })

// Use Redis-backed rate limiter
// (pass to PolicyEngine via config.rateLimit or custom plugin)
```

> Note: A `RedisSpendStore` (multi-process `SpendStore`) is the main remaining production gap. Implement `SpendStore` with `ZADD`/`ZRANGEBYSCORE` on `SpendRecord.timestamp` for a production-grade solution.

### Pattern C — Express/Fastify middleware (OpenAI-compatible gateway)

FreeRouter exposes a `createMiddleware` adapter so any client that speaks the OpenAI Chat Completions API works without changes.

```typescript
import { FreeRouter } from 'freerouter'
import { createMiddleware } from 'freerouter/adapters'

const router = new FreeRouter({ /* ... */ })
await router.init()

// Fastify
app.post('/v1/chat/completions', async (req, reply) => {
  const handler = createMiddleware(router, {
    extractUserId: (r) => r.headers['x-user-id'] ?? 'anon',
    extractContext: (r) => ({
      orgId: r.headers['x-org-id'],
      teamId: r.headers['x-team-id'],
    }),
  })
  return handler(req.raw, reply.raw)
})
```

### Pattern D — Serverless (AWS Lambda / Vercel)

FreeRouter is stateless by design; spin up one instance per cold start. Use `MemorySpendStore` with a Lambda-level singleton and flush to DynamoDB or S3 on `shutdown()`.

```typescript
// lambda-handler.ts
import { FreeRouter } from 'freerouter'
import { MemorySpendStore } from 'freerouter/finops'

let router: FreeRouter | undefined

async function getRouter() {
  if (router !== undefined) return router
  router = new FreeRouter({
    masterKey: process.env.ROUTER_MASTER_KEY!,
    spendPersistence: {
      store: new MemorySpendStore(), // swap for S3SpendStore in production
    },
  })
  await router.init()
  return router
}

export const handler = async (event: APIGatewayEvent) => {
  const r = await getRouter()
  // ... route request
}
```

### Environment variables used by FreeRouter

| Variable | Purpose |
|---|---|
| `ROUTER_MASTER_KEY` | 32-byte hex master key for AES-256-GCM key derivation |
| `FREEROUTER_CONFIG` | Path to config file loaded by `FreeRouter.fromEnv()` |
| `FREEROUTER_NEW_KEY` | New API key passed to the `freerouter rotate-key` CLI command |

---

## 6. Enterprise Use Cases

### Use case 1 — Internal AI developer portal

**Scenario:** A 500-person tech company wants to give every engineer access to LLMs for coding assistance. Each engineer uses their own OpenAI or Anthropic key. Finance wants monthly budget caps per team, chargeback reporting, and to never pay for another team's overspend.

**FreeRouter fit:**
- Each engineer registers their key once via your portal. FreeRouter encrypts it immediately and stores only the ciphertext.
- Budget policies cap spend per team per month. When engineering's $500/month cap is reached, further requests are downgraded to a cheaper model or blocked — sales team is unaffected.
- At month-end, run `router.getChargebackReport({ type: 'org', orgId: 'acme' }, startOfMonth, endOfMonth)` and pipe `byTeam` into your ERP/billing system.
- The `onBudgetWarning` hook sends a Slack alert to the team lead at 80%.

### Use case 2 — SaaS product with customer BYOK

**Scenario:** A startup builds a document analysis product. Each B2B customer brings their own Claude API key. The startup's infrastructure must not be able to read customer keys or accumulate customer LLM costs.

**FreeRouter fit:**
- Customer keys are stored with AES-256-GCM encryption, keyed to each customer's `userId`. The plaintext key never appears in logs or database rows.
- Spend is tracked per `orgId` (customer org). If a customer's usage spikes (runaway loop, accidental mass-send), `onLimitReached: 'block'` protects the customer from a massive bill.
- `getChargebackReport({ type: 'org', orgId: customerId })` powers the usage dashboard in the customer's account settings.
- The `HttpPricingSource` keeps the cost calculations up-to-date when OpenAI or Anthropic changes their prices.

### Use case 3 — Enterprise compliance hold

**Scenario:** Legal discovers that a specific model version has a data retention policy that conflicts with the company's GDPR obligations. The model must be blocked immediately across all teams — no redeployment window available.

**FreeRouter fit:**
- Call `router.blockModel('openai', 'gpt-4o-2024-05-13')` on the running instance. All subsequent requests to that model version are rejected instantly.
- Historical spend records and pricing data for that model are preserved (unlike `removeModel` which also strips pricing — useful for audit trails).
- When legal clears the model, call `router.unblockModel('openai', 'gpt-4o-2024-05-13')` to restore routing.
- The admin action is recorded in the audit trail as `model:removed` / `model:added`.

### Use case 4 — Overnight batch processing cost reduction

**Scenario:** A data team runs nightly summarisation jobs that process 50 000 support tickets. These jobs are not latency-sensitive but currently cost $800/night using GPT-4o.

**FreeRouter fit:**
- Configure `costOptimization: { strategy: 'cheapest', candidateModels: ['gpt-4o-mini', 'gemini-2.0-flash-lite'], batchOnly: true }`.
- Tag all batch jobs with `priority: 'batch'`. FreeRouter automatically routes to the cheapest capable model — typically `gpt-4o-mini` at $0.15/1M input vs GPT-4o's $2.50/1M, a ~16× reduction.
- Interactive user-facing requests use `priority: 'realtime'` and stay on GPT-4o.
- `SpendForecaster` sends a `forecast:at-risk` alert if even the reduced batch spend is trending over the weekly cap.

### Use case 5 — Multi-provider resilience with live pricing

**Scenario:** A fintech runs a high-volume LLM pipeline. Anthropic has periodic API outages. When Anthropic is down, traffic must automatically reroute to OpenAI without a redeploy. Additionally, pricing changes frequently as both providers compete on rates.

**FreeRouter fit:**
- Register both providers. Set `defaultProvider: 'anthropic'` and configure a `downgrade` policy that falls back to an OpenAI model when the Anthropic budget is exhausted (or extend it with a health-check plugin that temporarily blocks the provider on repeated 5xx responses).
- `HttpPricingSource` polls an internal pricing service every hour. When Anthropic drops input prices, FreeRouter automatically recalculates estimated costs and spend records reflect the new rates on the next refresh — no restart, no redeploy.
- `router.healthCheck()` exposes provider availability for your monitoring dashboard.

### Use case 6 — Value-based routing for differentiated tiers

**Scenario:** A consulting firm pays for LLM access across legal, marketing, and engineering teams. Pure cost minimization is the wrong default — the legal team's contract review must use the highest-quality model available regardless of cost, marketing's bulk content generation should hit the cheapest viable model, and a `code-review` use-case across any team must always use a frontier model. Additionally, contractor accounts must never be allowed to call frontier models.

**FreeRouter fit:**
- Configure the rules engine in `pin-wins` mode with declarative match→action rules. Legal team gets `pin: claude-3-5-sonnet`. Code-review metadata gets `strategy: performance`. Contractor org + frontier model glob gets `block`.
- Marketing falls through to the configured `costOptimization.strategy: 'cheapest'` for free.
- Rules live in a JSON file managed by the platform admin. `FileRulesSource` polls every 60s — admins update routing policy without a redeploy.
- Every routed request carries the matched `ruleId` into the audit trail, so finance and compliance can prove which directive applied per request.
- Rules can be added/removed at runtime via `router.setRule()` / `removeRule()` for incident response (e.g., temporary VIP routing during a customer escalation).

### Use case 7 — Regulated industry audit trail

**Scenario:** A healthcare SaaS must demonstrate to auditors that no patient data was sent to an unapproved model and that all API key operations are logged.

**FreeRouter fit:**
- `allowedModels: ['claude-3-5-sonnet-20241022', 'claude-3-haiku-20240307']` rejects any request to an unlisted model before it leaves the process.
- `blockedProviders: ['openai', 'google', 'mistral', 'groq']` ensures only Anthropic can be used.
- Every `key:set`, `key:rotated`, `key:deleted`, `request:sent`, `request:blocked`, and `policy:violated` event writes a structured `AuditEntry` to your `AuditSink` (an append-only database table, SIEM, etc.).
- `requestSigning: true` attaches an HMAC-SHA256 digest of every request so the audit trail can prove the content hash of each call sent.
- `promptInjectionGuard: true` prevents adversarial prompts from reaching the model.
- The `FileSpendStore` with daily flush gives auditors a point-in-time snapshot of all spend with full attribution by user, team, and department.

---

## 7. Troubleshooting

### "No API key set for user X / provider Y"

The user hasn't registered their key yet. Call `router.setKey(userId, providerName, apiKey)` before routing any request for that user+provider pair.

### "Request blocked: Budget policy exceeded"

The user or their team/org has exceeded the configured `maxSpendUsd` for the policy window. Check `error.message` for the policy ID. Options:
- Increase `maxSpendUsd` for the policy.
- Change `onLimitReached` to `downgrade` to keep serving (cheaper model) rather than blocking.
- Check `router.getSpend(scope, window)` to see the current accumulated spend.

### "Cannot determine provider for model X"

FreeRouter can't resolve the model to a provider. Either:
- Prefix the model: `"openai/gpt-4o"` instead of `"gpt-4o"`.
- Set `defaultProvider: 'openai'` in the config.
- Add a custom routing prefix via `config.providers['openai'].routingPrefixes`.

### Spend records are empty after restart

You don't have a `SpendStore` configured, or `router.init()` wasn't called before the first request.

```typescript
const router = new FreeRouter({ spendPersistence: { store: new FileSpendStore('./spend.json') } })
await router.init() // load records from disk BEFORE first request
```

### Pricing is stale after provider price change

Call `router.refreshPricing()` manually, or configure `pricingRefresh.intervalMs`. If using a `FilePricingSource`, edit the JSON file — the next scheduled refresh will pick it up automatically.

### "Model X has been removed from provider Y"

The model was blocked via `router.blockModel()` or `router.removeModel()`. Check with your admin. If it was a `blockModel()` call (reversible), use `router.unblockModel()`. If it was `removeModel()`, use `router.addModel()` to re-register with pricing.

### Tests pass but production spend counts are wrong in multi-process deployment

`FileSpendStore` is single-process only — each process maintains its own in-memory state and writes its own file. In multi-process deployments you need a shared `SpendStore` backed by Redis or a database. Implement the two-method `SpendStore` interface against your store of choice.
