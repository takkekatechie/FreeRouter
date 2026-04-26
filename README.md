# FreeRouter

> **Embeddable BYOK LLM router with enterprise FinOps, sub-5ms overhead, and AES-256-GCM key security.**

FreeRouter is a zero-runtime-dependency TypeScript library designed for enterprise applications that need to route LLM requests securely while users "Bring Their Own Key" (BYOK).

It enforces military-grade key isolation, protects against prompt injection, and limits spend via a cascading FinOps engine—all with virtually zero latency overhead.

---

## Features

- ⚡ **Zero runtime dependencies** — smaller than 50 KB bundled, no supply-chain risk.
- 🔐 **AES-256-GCM Key At-Rest** — credentials are never exposed, injected only at the moment of HTTP transfer, and zero-filled from memory immediately.
- 💰 **Enterprise FinOps** — cascading budgets (`global → org → dept → team → user`), per-model caps, spend forecasting, and ERP-ready chargeback reporting.
- 💾 **Spend Persistence** — durable spend history across restarts via `FileSpendStore` or any custom `SpendStore` adapter. Ad-hoc, scheduled, and always-on-exit flushing.
- 💡 **Variable Cost Optimization** — automatic model downgrade for batch requests, cache-aware cost calculation, sub-millisecond model selection.
- 🔄 **Live Pricing & Rate Limits** — fetch current model pricing and provider-declared rate caps from any HTTP endpoint or local JSON file. Zero restart required.
- 🛡️ **Hardened Security** — HMAC-SHA256 request signing, NFKD unicode normalization, and 14+ pattern prompt-injection guard.
- ⚙️ **Pluggable & Config-Driven** — configure via code, JSON, YAML, or TOML. Unused providers are never instantiated.
- 📡 **Native Streaming** — full `AsyncGenerator` support for all providers.

### Supported Providers
- Google Gemini (`gemini`)
- OpenAI (`gpt`, `o3`, `o4`)
- Anthropic (`claude`)
- Mistral (`mistral`, `mixtral`, `codestral`)
- Groq (`llama`, `gemma`)

*(Chinese models/providers like DeepSeek, Qwen, etc. are explicitly unsupported/blocked by default registry policy.)*

---

## Installation

```bash
npm install freerouter
```

---

## Quick Start

### 1. Initialize the Router

You can create a router entirely in code, or load it from a config file (JSON, YAML, TOML).

```typescript
import { FreeRouter } from 'freerouter'

// From a JSON config file (calls init() automatically)
const router = await FreeRouter.fromFile('./freerouter.config.json')

// Or programmatically
const router = new FreeRouter({
  defaultProvider: 'google',
  promptInjectionGuard: true,
  masterKey: process.env.ROUTER_MASTER_KEY,
  audit: { enabled: true }
})
await router.init() // load persisted spend + pricing on startup
```

### 2. Register a User's Key (BYOK)

```typescript
// The key is immediately encrypted and never stored in plain text
router.setKey('user-123', 'google', 'AIzaSyB-fake-key-example')
```

### 3. Route a Chat Request

```typescript
try {
  const response = await router.chat('user-123', {
    model: 'gemini-2.0-flash',
    messages: [{ role: 'user', content: 'Explain quantum computing in one sentence.' }]
  })
  console.log(response.content)
} catch (err) {
  console.error('Request blocked or failed:', err.message)
}
```

### 4. Route a Streaming Request

```typescript
const stream = router.chatStream('user-123', {
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'Write a poem' }]
})

for await (const chunk of stream) {
  process.stdout.write(chunk.delta)
}
```

### 5. Graceful Shutdown

```typescript
// Always call shutdown() before process exit to guarantee spend data is persisted.
process.on('SIGTERM', async () => {
  await router.shutdown()
  process.exit(0)
})
// When spendPersistence.autoFlushOnExit is true (default), this is done automatically.
```

---

## Enterprise FinOps

### Hierarchical Budgets

FreeRouter evaluates budgets cascading from global → org → department → team → user **before** sending requests to the provider.

```json
{
  "budgets": [
    {
      "id": "org-monthly",
      "scope": { "type": "org", "orgId": "acme" },
      "window": "monthly",
      "maxSpendUsd": 500,
      "onLimitReached": "warn",
      "alertThresholds": [50, 80, 95]
    },
    {
      "id": "team-daily",
      "scope": { "type": "team", "orgId": "acme", "teamId": "engineering" },
      "window": "daily",
      "maxSpendUsd": 25,
      "onLimitReached": "downgrade",
      "fallbackModel": "gemini-2.0-flash-lite"
    },
    {
      "id": "user-hourly",
      "scope": { "type": "user", "userId": "default" },
      "window": "hourly",
      "maxSpendUsd": 2,
      "onLimitReached": "block"
    }
  ]
}
```

Pass hierarchical context with each request:

```typescript
await router.chat('user-1', req, {
  orgId: 'acme',
  departmentId: 'product',
  teamId: 'engineering'
})
```

### Spend Persistence

Persist spend records across restarts so budget counters survive process recycling.

```typescript
import { FreeRouter } from 'freerouter'
import { FileSpendStore } from 'freerouter/adapters'

const router = new FreeRouter({
  spendPersistence: {
    store: new FileSpendStore('./data/spend.json'),
    intervalMs: 60_000,      // flush every 60 s
    autoFlushOnExit: true,   // always flush on SIGINT / SIGTERM (default: true)
  }
})
await router.init() // loads historical records from disk

// Ad-hoc flush (e.g. before a maintenance window)
await router.flushSpend()
```

Implement the `SpendStore` interface to use any backend (Redis, Postgres, S3):

```typescript
import type { SpendStore } from 'freerouter'

class RedisSpendStore implements SpendStore {
  async load() { /* ... */ }
  async save(records) { /* ... */ }
}
```

### Forecasting & Chargeback

```typescript
// Burn-rate forecast
const forecast = router.getForecast({ type: 'org', orgId: 'acme' }, 'monthly', 500)
console.log(forecast.recommendation) // "on-track" | "at-risk" | "over-budget"
console.log(`Budget exhausted at: ${new Date(forecast.estimatedBudgetExhaustionAt)}`)

// ERP-ready chargeback report
const report = router.getChargebackReport(
  { type: 'org', orgId: 'acme' },
  new Date('2026-04-01'),
  new Date('2026-04-30')
)
// report.byTeam, report.byDepartment, report.byUser, report.byProvider, report.byModel
```

---

## Variable Cost Optimization

### Automatic Model Selection

Route batch/background requests to the cheapest capable model automatically.

```typescript
const router = new FreeRouter({
  costOptimization: {
    strategy: 'cheapest',          // 'cheapest' | 'balanced' | 'performance'
    candidateModels: [
      'gemini-2.0-flash-lite',    // cheapest candidate
      'gemini-2.0-flash',
      'gpt-4o-mini',
    ],
    minCostThresholdUsd: 0.001,   // don't optimize sub-penny requests
    batchOnly: true,               // only optimize when priority === 'batch'
  }
})

// Realtime request — uses requested model
await router.chat('user-1', { model: 'gpt-4o', priority: 'realtime', messages })

// Batch request — automatically routed to cheapest candidate
await router.chat('user-1', { model: 'gpt-4o', priority: 'batch', messages })
```

Model selection is pure in-memory computation — **zero I/O, sub-millisecond overhead**.

### Cache-Aware Cost Calculation

When providers return `cachedPromptTokens` in the response (Anthropic prompt cache, OpenAI cached inputs), FreeRouter automatically applies the discounted rate:

```typescript
// In ModelPricingEntry or PricingManifest:
{
  "claude-3-5-sonnet-20241022": {
    "input": 3.0,
    "output": 15.0,
    "cachedInput": 0.30  // 10% of input — Anthropic cache read rate
  }
}
```

The actual spend recorded in `SpendRecord` reflects the discounted cost, not the list price.

---

## Admin Rules Engine — Value-Based Overrides

Pure cost-based routing isn't always right. The legal team should always use Sonnet regardless of cost. VIP customers should never be downgraded. Contractors should be blocked from GPT-4o. The rules engine lets the admin express these *value-based* directives that override cost optimization.

Rules match on `userId` / `orgId` / `departmentId` / `teamId` / `metadata` / `priority` / model glob, and emit one of three actions: **pin** a specific model, override the **strategy** for the cost router, or **block** the request.

```typescript
import { FreeRouter } from 'freerouter'
import { FileRulesSource } from 'freerouter/adapters'

const router = new FreeRouter({
  costOptimization: {
    strategy: 'cheapest',
    candidateModels: ['gemini-2.0-flash-lite', 'gpt-4o-mini'],
  },
  rules: {
    mode: 'pin-wins',
    rules: [
      // Legal team always uses Sonnet — value over cost
      { id: 'legal-quality', priority: 100,
        match: { teamId: 'legal' },
        action: { type: 'pin', model: 'anthropic/claude-3-5-sonnet-20241022' } },

      // Code review use-case → highest-quality routing
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

await router.chat('alice', { model: 'gemini-2.0-flash', messages }, { teamId: 'legal' })
// → routes to claude-3-5-sonnet (rule overrides cheapest)
```

### Modes

| Mode                | Pin behavior                                               | Strategy behavior                                  |
| ------------------- | ---------------------------------------------------------- | -------------------------------------------------- |
| `pin-wins`          | Pinned model is used directly; cost router bypassed.       | Cost router runs with the rule's strategy.         |
| `narrow-candidates` | Cost router runs with `[pinned-model]` as the only choice. | Cost router runs with the rule's strategy.         |
| `post-override`     | Cost router runs, then pin replaces the result.            | Cost router runs with the rule's strategy.         |

### Hot-reloadable rules

Drop a JSON file on disk; refresh on a schedule or on demand.

```typescript
new FreeRouter({
  rules: { mode: 'pin-wins', rules: [] },
  rulesRefresh: {
    source: new FileRulesSource('./config/rules.json'),
    intervalMs: 60_000, // poll every minute, or omit for manual refreshRules()
  },
  onRulesRefreshed: count => console.log(`Loaded ${count} rules`),
})
```

### Runtime API

```typescript
router.setRule({ id: 'vip-alice', match: { userId: 'alice' },
                 action: { type: 'strategy', strategy: 'performance' } })
router.removeRule('vip-alice')
router.listRules() // priority-sorted snapshot
await router.refreshRules() // pull latest from rulesRefresh.source
```

Rules run **before** the cost router and **before** policy/budget evaluation. Each request that matches a rule carries the `ruleId` into the audit trail.

---

## Live Pricing & Rate Limits

Keep model pricing and rate-limit caps current without restarts.

### HTTP Pricing Source

```typescript
import { FreeRouter } from 'freerouter'
import { HttpPricingSource } from 'freerouter/finops'

const router = new FreeRouter({
  pricingRefresh: {
    source: new HttpPricingSource('https://pricing.example.com/llm-rates.json', {
      bearerToken: process.env.PRICING_TOKEN,
      timeoutMs: 5_000,
    }),
    intervalMs: 3_600_000, // refresh every hour
  },
  onPricingRefreshed: (count) => console.log(`Updated ${count} model rates`),
})
await router.init() // fetches pricing immediately, then on schedule
```

### File-Based Pricing Source

```typescript
import { FilePricingSource } from 'freerouter/adapters'

const router = new FreeRouter({
  pricingRefresh: {
    source: new FilePricingSource('./config/pricing.json'),
    intervalMs: 300_000,  // re-read file every 5 min (hot-swap without restart)
  }
})
```

**Pricing manifest format** (`pricing.json`):

```json
{
  "anthropic": {
    "claude-3-5-sonnet-20241022": { "input": 3.0, "output": 15.0, "cachedInput": 0.30, "rpmLimit": 500 },
    "claude-3-haiku-20240307":    { "input": 0.25, "output": 1.25, "cachedInput": 0.03 }
  },
  "openai": {
    "gpt-4o":      { "input": 2.50, "output": 10.0,  "cachedInput": 1.25, "rpmLimit": 500 },
    "gpt-4o-mini": { "input": 0.15, "output": 0.60,  "cachedInput": 0.075 }
  }
}
```

### Manual Pricing Override

```typescript
// Override a single model's pricing at runtime
router.setPricingOverride('openai', 'gpt-4o', {
  input: 2.50,
  output: 10.0,
  cachedInput: 1.25,
})

// Or refresh all at once from a file
await router.refreshPricing()
```

---

## Admin: Model Blocking

Block models at runtime without removing their pricing or spend history.

```typescript
// Compliance hold — block immediately, reversible
router.blockModel('openai', 'gpt-4o')

// Test the block
await router.chat('user-1', { model: 'gpt-4o', messages })
// ↑ throws: [FreeRouter] Model "gpt-4o" has been removed from provider "openai"

// Lift the hold
router.unblockModel('openai', 'gpt-4o')

// Permanent removal (also removes pricing entry — use removeModel for hard deletes)
router.removeModel('openai', 'gpt-4o')
```

---

## Advanced Extensibility

FreeRouter provides tree-shakeable sub-path exports for granular control over exactly what gets bundled into your application.

```typescript
// Import only the FinOps engine
import { SpendTracker, PolicyEngine, CostRouter } from 'freerouter/finops'

// Import only the Security abstractions
import { KeyManager, InputValidator } from 'freerouter/security'

// Import Node.js adapters
import { FileSpendStore, FilePricingSource, RedisKeyStore } from 'freerouter/adapters'
```

### Custom Providers

```typescript
import { BaseProvider } from 'freerouter/providers'

class InternalProvider extends BaseProvider { ... }

router.registerProvider(new InternalProvider())
```

---

## License

MIT License.
