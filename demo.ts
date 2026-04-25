/**
 * FreeRouter — Live Demo with Google Gemini
 *
 * Usage:
 *   set GEMINI_API_KEY=your_key_here
 *   npx tsx demo.ts
 */

import { FreeRouter } from './src/index.js'

const apiKey = process.env['GEMINI_API_KEY']
if (!apiKey) {
  console.error('❌  Set GEMINI_API_KEY environment variable first.')
  process.exit(1)
}

// ─── Router configuration ──────────────────────────────────────────
const router = new FreeRouter({
  defaultProvider: 'google',
  promptInjectionGuard: true,
  audit: {
    enabled: true,
    // Default sink = stdout JSON; you'd plug in a SIEM or file sink in production
  },
  budgets: [
    {
      id: 'demo-daily-cap',
      scope: { type: 'user', userId: 'demo-user' },
      window: 'daily',
      maxSpendUsd: 1.00,
      maxRequests: 100,
      onLimitReached: 'warn',
      alertThresholds: [50, 80, 95],
    },
    {
      id: 'demo-hourly-cap',
      scope: { type: 'user', userId: 'demo-user' },
      window: 'hourly',
      maxSpendUsd: 0.10,
      onLimitReached: 'downgrade',
      fallbackModel: 'gemini-2.0-flash-lite',
      priority: 10, // evaluated first
    },
  ],
  onBudgetWarning: (scope, summary) => {
    console.log(`\n⚠️  Budget warning — scope: ${scope.type}, spent: $${summary.spendUsd.toFixed(4)}`)
  },
  onBudgetExceeded: (scope, summary) => {
    console.log(`\n🚫 Budget exceeded — scope: ${scope.type}, spent: $${summary.spendUsd.toFixed(4)}`)
  },
  onRequestComplete: (record) => {
    console.log(`\n💸 Request cost: $${record.costUsd.toFixed(6)} | tokens: ${record.tokens.totalTokens}`)
  },
})

// ─── Register API key (BYOK — encrypted immediately) ──────────────────
router.setKey('demo-user', 'google', apiKey, { orgId: 'demo-org', teamId: 'demo-team' })
console.log('🔐 Gemini API key registered and encrypted in memory.\n')

// ─── Demo 1: Standard chat ────────────────────────────────────────────
console.log('═══ Demo 1: Standard Chat ═══')
const response = await router.chat(
  'demo-user',
  {
    model: 'gemini-2.0-flash',
    messages: [
      { role: 'system', content: 'You are a concise assistant. Answer in 2 sentences max.' },
      { role: 'user', content: 'What is LLM routing and why is it important?' },
    ],
    temperature: 0.3,
  },
  { orgId: 'demo-org', teamId: 'demo-team' },
)

console.log('📝 Response:')
console.log(response.content)
console.log(`\n⏱  Latency: ${response.latencyMs}ms`)

// ─── Demo 2: Streaming chat ───────────────────────────────────────────
console.log('\n═══ Demo 2: Streaming Chat ═══')
process.stdout.write('📡 Stream: ')

for await (const chunk of router.chatStream(
  'demo-user',
  {
    model: 'gemini-2.0-flash',
    messages: [{ role: 'user', content: 'List 3 benefits of API key encryption in one line each.' }],
  },
  { orgId: 'demo-org', teamId: 'demo-team' },
)) {
  if (chunk.delta) process.stdout.write(chunk.delta)
  if (chunk.done && chunk.usage) {
    console.log(`\n\n📊 Final usage: ${JSON.stringify(chunk.usage)}`)
  }
}

// ─── Demo 3: FinOps — Spend summary ───────────────────────────────────
console.log('\n═══ Demo 3: FinOps — Spend Summary ═══')
const spend = router.getSpend({ type: 'user', userId: 'demo-user' }, 'daily')
console.log(`User spend today: $${spend.spendUsd.toFixed(6)} (${spend.requests} requests, ${spend.tokens.totalTokens} tokens)`)

// ─── Demo 4: FinOps — Spend Forecast ──────────────────────────────────
console.log('\n═══ Demo 4: FinOps — Forecast ═══')
const forecast = router.getForecast({ type: 'user', userId: 'demo-user' }, 'daily', 1.00)
console.log(`Burn rate: $${forecast.burnRate.toFixed(6)}/hr`)
console.log(`Projected spend: $${forecast.projectedSpendUsd.toFixed(6)}`)
console.log(`Status: ${forecast.recommendation}`)

// ─── Demo 5: FinOps — Chargeback Report ───────────────────────────────
console.log('\n═══ Demo 5: FinOps — Chargeback Report ═══')
const report = router.getChargebackReport(
  { type: 'org', orgId: 'demo-org' },
  new Date(Date.now() - 24 * 60 * 60 * 1000),
  new Date(),
)
console.log(`Org total spend: $${report.totalSpendUsd.toFixed(6)}`)
console.log('By provider:', report.byProvider)
console.log('By model:   ', report.byModel)
console.log('By user:    ', report.byUser)

console.log('\n✅ Demo complete.')
