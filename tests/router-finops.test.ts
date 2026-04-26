import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { FreeRouter } from '../src/router.js'
import { MemorySpendStore } from '../src/finops/spend-store.js'
import { FileSpendStore } from '../src/adapters/file-spend-store.js'
import { StaticPricingSource } from '../src/finops/pricing-source.js'
import type { BaseProvider } from '../src/providers/base-provider.js'
import type { ChatRequest, ChatResponse, StreamChunk, SpendRecord } from '../src/types.js'

// ── Shared helpers ──────────────────────────────────────────────────────────

const masterKey = Buffer.alloc(32, 'd').toString('hex')

class MockProvider implements BaseProvider {
  readonly name: string
  private readonly inputRate: number
  constructor(name: string, inputRate = 1.0) {
    this.name = name
    this.inputRate = inputRate
  }
  async chat(req: ChatRequest, _k: string): Promise<ChatResponse> {
    return {
      id: 'x', model: req.model, content: 'ok', provider: this.name,
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      latencyMs: 1, finishedAt: Date.now(),
    }
  }
  async *chatStream(_req: ChatRequest, _k: string): AsyncIterable<StreamChunk> {
    yield { delta: 'ok', done: false }
    yield { delta: '', done: true, usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } }
  }
  pricing(_model: string) { return { input: this.inputRate, output: this.inputRate * 3 } }
}

function makeGeminiMock(content = 'ok') {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      candidates: [{ content: { parts: [{ text: content }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
    }),
    body: null, status: 200, statusText: 'OK',
  })
}

// ── SpendPersistence: router.init() / flushSpend() / shutdown() ─────────────

describe('Spend persistence', () => {
  it('init() loads records from MemorySpendStore', async () => {
    const store = new MemorySpendStore()
    const record: SpendRecord = {
      userId: 'u1', provider: 'google', model: 'gemini-2.0-flash',
      tokens: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      costUsd: 5.00, timestamp: Date.now(),
    }
    await store.save([record])

    const router = new FreeRouter({ masterKey, audit: { enabled: false }, spendPersistence: { store } })
    await router.init()

    const summary = router.getSpend({ type: 'user', userId: 'u1' }, 'daily')
    expect(summary.spendUsd).toBeCloseTo(5.00, 4)
    expect(summary.requests).toBe(1)
  })

  it('flushSpend() saves current records to store', async () => {
    const store = new MemorySpendStore()
    vi.stubGlobal('fetch', makeGeminiMock())
    const router = new FreeRouter({ masterKey, audit: { enabled: false }, spendPersistence: { store } })
    await router.init()

    router.setKey('u1', 'google', 'key')
    await router.chat('u1', { model: 'gemini-2.0-flash', messages: [{ role: 'user', content: 'hi' }] })

    await router.flushSpend()
    const saved = await store.load()
    expect(saved.length).toBeGreaterThan(0)
    expect(saved[0]?.userId).toBe('u1')
  })

  it('flushSpend() is a no-op when no store is configured', async () => {
    const router = new FreeRouter({ masterKey, audit: { enabled: false } })
    await expect(router.flushSpend()).resolves.toBeUndefined()
  })

  it('shutdown() flushes records and clears the flush interval', async () => {
    const store = new MemorySpendStore()
    const router = new FreeRouter({
      masterKey, audit: { enabled: false },
      spendPersistence: { store, intervalMs: 60_000, autoFlushOnExit: false },
    })
    await router.init()

    // Inject a spend record directly to verify it gets flushed
    const tracker = (router as unknown as { tracker: { recordSpend: (r: SpendRecord) => void } }).tracker
    tracker.recordSpend({
      userId: 'u1', provider: 'test', model: 'test-model',
      tokens: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      costUsd: 1.00, timestamp: Date.now(),
    })

    await router.shutdown()
    const saved = await store.load()
    expect(saved).toHaveLength(1)
    expect(saved[0]?.costUsd).toBe(1.00)
  })

  it('init() is idempotent — calling twice does not double-load records', async () => {
    const store = new MemorySpendStore()
    const record: SpendRecord = {
      userId: 'u1', provider: 'google', model: 'gemini-2.0-flash',
      tokens: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      costUsd: 2.00, timestamp: Date.now(),
    }
    await store.save([record])

    const router = new FreeRouter({ masterKey, audit: { enabled: false }, spendPersistence: { store } })
    await router.init()
    await router.init() // second call — must be no-op

    const summary = router.getSpend({ type: 'user', userId: 'u1' }, 'daily')
    expect(summary.requests).toBe(1) // not doubled
  })

  describe('FileSpendStore integration', () => {
    let dir: string

    beforeEach(async () => {
      dir = join(tmpdir(), `fr-router-finops-${Date.now()}-${Math.random().toString(36).slice(2)}`)
      await mkdir(dir, { recursive: true })
    })

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true })
    })

    it('persists and reloads records across router instances', async () => {
      const filePath = join(dir, 'spend.json')
      vi.stubGlobal('fetch', makeGeminiMock())

      // First router instance — make a request then flush
      const store1 = new FileSpendStore(filePath)
      const router1 = new FreeRouter({
        masterKey, audit: { enabled: false },
        spendPersistence: { store: store1, autoFlushOnExit: false },
      })
      await router1.init()
      router1.setKey('u1', 'google', 'key')
      await router1.chat('u1', { model: 'gemini-2.0-flash', messages: [{ role: 'user', content: 'hi' }] })
      await router1.flushSpend()

      // Second router instance — loads from file, should see prior spend
      const store2 = new FileSpendStore(filePath)
      const router2 = new FreeRouter({
        masterKey, audit: { enabled: false },
        spendPersistence: { store: store2, autoFlushOnExit: false },
      })
      await router2.init()
      const summary = router2.getSpend({ type: 'user', userId: 'u1' }, 'daily')
      expect(summary.requests).toBe(1)
      expect(summary.spendUsd).toBeGreaterThan(0)
    })
  })
})

// ── router.refreshPricing() ─────────────────────────────────────────────────

describe('refreshPricing()', () => {
  it('applies manifest to registry — updated pricing is used for cost calculation', async () => {
    vi.stubGlobal('fetch', makeGeminiMock())
    const pricingSource = new StaticPricingSource({
      google: { 'gemini-2.0-flash': { input: 99.0, output: 99.0 } }, // artificially high
    })

    const router = new FreeRouter({
      masterKey, audit: { enabled: false },
      pricingRefresh: { source: pricingSource },
    })
    await router.init()

    router.setKey('u1', 'google', 'key')
    await router.chat('u1', { model: 'gemini-2.0-flash', messages: [{ role: 'user', content: 'hi' }] })
    const summary = router.getSpend({ type: 'user', userId: 'u1' }, 'daily')

    // With $99/1M rate, 10 prompt + 5 completion tokens → should be non-trivial
    expect(summary.spendUsd).toBeGreaterThan(0)
  })

  it('is a no-op when pricingRefresh is not configured', async () => {
    const router = new FreeRouter({ masterKey, audit: { enabled: false } })
    await expect(router.refreshPricing()).resolves.toBeUndefined()
  })

  it('calls onPricingRefreshed with the count of updated models', async () => {
    const onRefreshed = vi.fn()
    const source = new StaticPricingSource({
      openai: { 'gpt-4o': { input: 2.50, output: 10.0 }, 'gpt-4o-mini': { input: 0.15, output: 0.60 } },
      google: { 'gemini-2.0-flash': { input: 0.10, output: 0.40 } },
    })
    const router = new FreeRouter({
      masterKey, audit: { enabled: false },
      pricingRefresh: { source },
      onPricingRefreshed: onRefreshed,
    })
    await router.refreshPricing()
    expect(onRefreshed).toHaveBeenCalledOnce()
    expect(onRefreshed.mock.calls[0]?.[0]).toBe(3) // 3 models updated
  })

  it('does not throw when source.fetch() rejects — logs to stderr instead', async () => {
    const failingSource = { fetch: async () => { throw new Error('network error') } }
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const router = new FreeRouter({
      masterKey, audit: { enabled: false },
      pricingRefresh: { source: failingSource },
    })
    await expect(router.refreshPricing()).resolves.toBeUndefined()
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('PricingSource fetch failed'))
    stderrSpy.mockRestore()
  })
})

// ── router.setPricingOverride() ─────────────────────────────────────────────

describe('setPricingOverride()', () => {
  it('overrides pricing for a specific model', async () => {
    vi.stubGlobal('fetch', makeGeminiMock())
    const router = new FreeRouter({ masterKey, audit: { enabled: false } })

    // Set an artificially high price
    router.setPricingOverride('google', 'gemini-2.0-flash', { input: 50.0, output: 50.0 })

    router.setKey('u1', 'google', 'key')
    await router.chat('u1', { model: 'gemini-2.0-flash', messages: [{ role: 'user', content: 'hi' }] })

    const summary = router.getSpend({ type: 'user', userId: 'u1' }, 'daily')
    // At $50/1M for 10 prompt + 5 completion = 15 tokens → $0.00075
    expect(summary.spendUsd).toBeGreaterThan(0.0005)
  })

  it('supports cachedInput pricing', () => {
    const router = new FreeRouter({ masterKey, audit: { enabled: false } })
    // Should not throw with optional cachedInput
    expect(() =>
      router.setPricingOverride('anthropic', 'claude-3-5-sonnet-20241022', {
        input: 3.0, output: 15.0, cachedInput: 0.30,
      })
    ).not.toThrow()
  })
})

// ── blockModel / unblockModel ───────────────────────────────────────────────

describe('blockModel() / unblockModel()', () => {
  let router: FreeRouter

  beforeEach(() => {
    vi.stubGlobal('fetch', makeGeminiMock())
    router = new FreeRouter({ masterKey, audit: { enabled: false } })
    router.setKey('u1', 'google', 'key')
  })

  it('blockModel() prevents routing to the model', async () => {
    router.blockModel('google', 'gemini-2.0-flash')
    await expect(
      router.chat('u1', { model: 'gemini-2.0-flash', messages: [{ role: 'user', content: 'hi' }] })
    ).rejects.toThrow('removed')
  })

  it('unblockModel() re-enables routing after a block', async () => {
    router.blockModel('google', 'gemini-2.0-flash')
    router.unblockModel('google', 'gemini-2.0-flash')
    const resp = await router.chat('u1', {
      model: 'gemini-2.0-flash',
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(resp.content).toBe('ok')
  })

  it('blockModel() differs from removeModel() — pricing history is preserved', async () => {
    // Record some spend first
    await router.chat('u1', { model: 'gemini-2.0-flash', messages: [{ role: 'user', content: 'hi' }] })
    const spendBefore = router.getSpend({ type: 'user', userId: 'u1' }, 'daily').spendUsd

    // Block the model (should NOT destroy pricing or spend)
    router.blockModel('google', 'gemini-2.0-flash')

    // Spend record still accessible
    const spendAfter = router.getSpend({ type: 'user', userId: 'u1' }, 'daily').spendUsd
    expect(spendAfter).toBeCloseTo(spendBefore, 6)
  })

  it('blocking a model that was never registered is safe (no throw)', () => {
    expect(() => router.blockModel('google', 'gemini-nonexistent')).not.toThrow()
  })

  it('unblocking an unblocked model is safe (no throw)', () => {
    expect(() => router.unblockModel('google', 'gemini-2.0-flash')).not.toThrow()
  })
})

// ── Cost optimization integration ───────────────────────────────────────────

describe('Cost optimization — router integration', () => {
  it('routes batch request to cheaper candidate model', async () => {
    const expensive = new MockProvider('expensive', 10.0) // $10/1M
    const cheap     = new MockProvider('cheap', 0.15)     // $0.15/1M

    const router = new FreeRouter({
      masterKey, audit: { enabled: false },
      costOptimization: {
        strategy: 'cheapest',
        candidateModels: ['cheap/any-model'],
        batchOnly: true,
      },
    })
    router.registerProvider(expensive)
    router.registerProvider(cheap)
    router.setKey('u1', 'expensive', 'key')
    router.setKey('u1', 'cheap', 'key')

    const resp = await router.chat('u1', {
      model: 'expensive/any-model',
      priority: 'batch',
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(resp.provider).toBe('cheap')
  })

  it('realtime request bypasses cost optimization when batchOnly is true', async () => {
    const expensive = new MockProvider('expensive2', 10.0)
    const cheap2    = new MockProvider('cheap2', 0.15)

    const router = new FreeRouter({
      masterKey, audit: { enabled: false },
      costOptimization: {
        strategy: 'cheapest',
        candidateModels: ['cheap2/any-model'],
        batchOnly: true,
      },
    })
    router.registerProvider(expensive)
    router.registerProvider(cheap2)
    router.setKey('u1', 'expensive2', 'key')
    router.setKey('u1', 'cheap2', 'key')

    const resp = await router.chat('u1', {
      model: 'expensive2/any-model',
      priority: 'realtime',
      messages: [{ role: 'user', content: 'hi' }],
    })
    // Should stay on expensive provider (realtime, not optimized)
    expect(resp.provider).toBe('expensive2')
  })

  it('cost-optimized spend is recorded at the cheaper model rate', async () => {
    const expensive = new MockProvider('pricey', 10.0)
    const cheap3    = new MockProvider('budget', 0.15)

    const router = new FreeRouter({
      masterKey, audit: { enabled: false },
      costOptimization: {
        strategy: 'cheapest',
        candidateModels: ['budget/m'],
        batchOnly: false,
      },
    })
    router.registerProvider(expensive)
    router.registerProvider(cheap3)
    router.setKey('u1', 'pricey', 'key')
    router.setKey('u1', 'budget', 'key')

    await router.chat('u1', {
      model: 'pricey/m',
      messages: [{ role: 'user', content: 'hi' }],
    })

    const summary = router.getSpend({ type: 'user', userId: 'u1' }, 'daily')
    // budget provider at $0.15/1M for 10+5=15 tokens → ~$0.0000034 (very small)
    // expensive at $10/1M would be ~$0.000225 — must be the cheaper one
    expect(summary.spendUsd).toBeLessThan(0.0001)
  })
})
