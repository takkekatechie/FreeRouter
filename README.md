# FreeRouter

> **Embeddable BYOK LLM router with enterprise FinOps, sub-5ms overhead, and AES-256-GCM key security.**

FreeRouter is a zero-runtime-dependency TypeScript library designed for enterprise applications that need to route LLM requests securely while users "Bring Their Own Key" (BYOK).

It enforces military-grade key isolation, protects against prompt injection, and limits spend via a cascading FinOps engine—all with virtually zero latency overhead.

---

## Features

- ⚡ **Zero runtime dependencies** — smaller than 50 KB bundled, no supply-chain risk.
- 🔐 **AES-256-GCM Key At-Rest** — credentials are never exposed, injected only at the moment of HTTP transfer, and zero-filled from memory immediately.
- 💰 **Enterprise FinOps** — cascading budgets (`global → org → dept → team → user`), per-model caps, spend forecasting, and ERP-ready chargeback reporting.
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

You can create a router entirely in code, or loud it from a config file (JSON, YAML, TOML).

```typescript
import { FreeRouter } from 'freerouter'

// From a JSON config file
const router = await FreeRouter.fromFile('./freerouter.config.json')

// Or programmatically
const router = new FreeRouter({
  defaultProvider: 'google',
  promptInjectionGuard: true,
  // 32-byte master key for AES-GCM encryption
  masterKey: process.env.ROUTER_MASTER_KEY, 
  audit: { enabled: true }
})
```

### 2. Register a User's Key (BYOK)

```typescript
// The key is immediately encrypted and never stored in plain text
router.setKey(
  'user-123', 
  'google', 
  'AIzaSyB-fake-key-example'
)
```

### 3. Route a Chat Request

```typescript
try {
  const response = await router.chat('user-123', {
    model: 'gemini-2.0-flash',
    messages: [
      { role: 'user', content: 'Explain quantum computing in one sentence.' }
    ]
  })
  
  console.log(response.content)
  console.log(`Cost: $${response.usage.totalTokens}`)
} catch (err) {
  console.error("Request blocked or failed:", err.message)
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
  
  if (chunk.done) {
    console.log(`\n\nFinal Cost: $${chunk.usage.totalTokens}`) // attached to last chunk
  }
}
```

---

## Enterprise FinOps

FreeRouter allows you to define hierarchical budgets. Requests are evaluated BEFORE network transmission to ensure budgets are respected.

### Setting Budgets

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

To validate requests against `org` and `team` budgets, pass the hierarchical context:

```typescript
await router.chat('user-1', req, {
  orgId: 'acme',
  departmentId: 'product',
  teamId: 'engineering'
})
```

### Forecasting & Chargeback

```typescript
// 1. Burn-Rate Forecast
const forecast = router.getForecast({ type: 'org', orgId: 'acme' }, 'monthly', 500)
console.log(forecast.recommendation) // "on-track" | "at-risk" | "over-budget"
console.log(`Estimated budget exhaustion: ${new Date(forecast.estimatedBudgetExhaustionAt)}`)

// 2. Chargeback generation (for ERP systems)
const report = router.getChargebackReport(
  { type: 'org', orgId: 'acme' }, 
  new Date('2026-04-01'), 
  new Date('2026-04-30')
)
```

---

## Advanced Extensibility

FreeRouter provides tree-shakeable sub-path exports for granular control over exactly what gets bundled into your application.

```typescript
// Import only the FinOps engine
import { SpendTracker, PolicyEngine } from 'freerouter/finops'

// Import only the Security abstractions
import { KeyManager, InputValidator } from 'freerouter/security'

// Import Providers
import { AnthropicProvider } from 'freerouter/providers'
```

### Custom Providers

You can register custom providers natively:

```typescript
import { BaseProvider } from 'freerouter/providers'

class InternalProvider extends BaseProvider { ... }

router.registerProvider(new InternalProvider())
```

---

## License

MIT License.
