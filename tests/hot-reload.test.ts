import { describe, it, expect, vi, beforeEach } from 'vitest'
import { FreeRouter } from '../src/router.js'
import type { BaseProvider } from '../src/providers/base-provider.js'
import type { ChatRequest, ChatResponse, StreamChunk } from '../src/types.js'

const masterKey = Buffer.alloc(32, 'c').toString('hex')

function makeGeminiMock(content = 'hello') {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      candidates: [{ content: { parts: [{ text: content }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 5, totalTokenCount: 10 },
    }),
    body: null, status: 200, statusText: 'OK',
  })
}

class MockProvider implements BaseProvider {
  readonly name: string
  private readonly response: string
  constructor(name: string, response = 'mock') {
    this.name = name
    this.response = response
  }
  async chat(req: ChatRequest, _apiKey: string): Promise<ChatResponse> {
    return {
      id: 'mock-id',
      model: req.model,
      content: this.response,
      usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
      latencyMs: 1,
      provider: this.name,
      finishedAt: Date.now(),
    }
  }
  async *chatStream(_req: ChatRequest, _apiKey: string): AsyncIterable<StreamChunk> {
    yield { delta: this.response, done: false }
    yield { delta: '', done: true, usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 } }
  }
  pricing(_model: string) { return { input: 1, output: 1 } }
}

describe('Hot-reload — addProvider / removeProvider', () => {
  let router: FreeRouter

  beforeEach(() => {
    router = new FreeRouter({ masterKey, audit: { enabled: false } })
    vi.stubGlobal('fetch', makeGeminiMock())
  })

  it('addProvider registers a new provider and routes to it', async () => {
    const mockProvider = new MockProvider('myprovider', 'from-mock')
    await router.addProvider('myprovider', () => mockProvider, ['mymock'])
    router.setKey('u1', 'myprovider', 'api-key')

    const resp = await router.chat('u1', {
      model: 'myprovider/my-model',
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(resp.content).toBe('from-mock')
    expect(resp.provider).toBe('myprovider')
  })

  it('addProvider appears in listProviders()', async () => {
    await router.addProvider('newco', () => new MockProvider('newco'), ['newco'])
    expect(router.listProviders()).toContain('newco')
  })

  it('emits provider:added event', async () => {
    const handler = vi.fn()
    router.on('provider:added', handler)
    await router.addProvider('evtco', () => new MockProvider('evtco'), [])
    expect(handler).toHaveBeenCalledOnce()
    expect(handler.mock.calls[0]?.[0]).toMatchObject({ providerName: 'evtco' })
  })

  it('removeProvider removes the provider; subsequent chat throws', async () => {
    await router.addProvider('tempco', () => new MockProvider('tempco'), ['tempmodel'])
    router.setKey('u1', 'tempco', 'key')
    await router.removeProvider('tempco')

    expect(router.listProviders()).not.toContain('tempco')
    await expect(
      router.chat('u1', { model: 'tempco/m', messages: [{ role: 'user', content: 'hi' }] })
    ).rejects.toThrow()
  })

  it('emits provider:removed event', async () => {
    const handler = vi.fn()
    await router.addProvider('todel', () => new MockProvider('todel'), [])
    router.on('provider:removed', handler)
    await router.removeProvider('todel')
    expect(handler).toHaveBeenCalledOnce()
    expect(handler.mock.calls[0]?.[0]).toMatchObject({ providerName: 'todel' })
  })

  it('removeProvider with force:true skips drain', async () => {
    await router.addProvider('fastco', () => new MockProvider('fastco'), [])
    // Should resolve immediately (no drain needed)
    await router.removeProvider('fastco', { force: true })
    expect(router.listProviders()).not.toContain('fastco')
  })

  it('addProvider re-enables a previously removed provider', async () => {
    await router.addProvider('reco', () => new MockProvider('reco', 'v1'), [])
    await router.removeProvider('reco')
    await router.addProvider('reco', () => new MockProvider('reco', 'v2'), [])
    router.setKey('u1', 'reco', 'key')
    const resp = await router.chat('u1', {
      model: 'reco/any',
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(resp.content).toBe('v2')
  })

  it('spend records accumulated before removeProvider remain queryable', async () => {
    await router.addProvider('spendco', () => new MockProvider('spendco'), [])
    router.setKey('u1', 'spendco', 'key')
    await router.chat('u1', { model: 'spendco/m', messages: [{ role: 'user', content: 'hi' }] })
    const before = router.getSpend({ type: 'user', userId: 'u1' }, 'daily')
    expect(before.requests).toBe(1)

    await router.removeProvider('spendco')
    const after = router.getSpend({ type: 'user', userId: 'u1' }, 'daily')
    expect(after.requests).toBe(1) // records survive removal
    expect(after.spendUsd).toBe(before.spendUsd)
  })

  it('removeProvider drain: waits for in-flight requests', async () => {
    const completionOrder: string[] = []
    let resolveRequest!: () => void

    const slowProvider: BaseProvider = {
      name: 'slowco',
      async chat(req: ChatRequest, _k: string): Promise<ChatResponse> {
        // Wait until external resolver fires
        await new Promise<void>(r => { resolveRequest = r })
        completionOrder.push('chat')
        return {
          id: 'x', model: req.model, content: 'slow',
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          latencyMs: 1, provider: 'slowco', finishedAt: Date.now(),
        }
      },
      async *chatStream(): AsyncIterable<StreamChunk> { yield { delta: '', done: true } },
      pricing: () => ({ input: 1, output: 1 }),
    }

    await router.addProvider('slowco', () => slowProvider, ['slowmodel'])
    router.setKey('u1', 'slowco', 'key')

    const chatPromise = router.chat('u1', {
      model: 'slowco/x',
      messages: [{ role: 'user', content: 'go' }],
    })

    // Start removal concurrently — it must drain before completing
    const removePromise = router.removeProvider('slowco').then(() => {
      completionOrder.push('remove')
    })

    // Give both promises a chance to start
    await new Promise(r => setImmediate(r))

    // Resolve the in-flight chat request
    resolveRequest()
    await chatPromise
    await removePromise

    // Removal must happen after chat completes (drain guarantee)
    expect(completionOrder).toEqual(['chat', 'remove'])
  })
})

describe('Hot-reload — addModel / removeModel', () => {
  let router: FreeRouter

  beforeEach(() => {
    router = new FreeRouter({ masterKey, audit: { enabled: false } })
    vi.stubGlobal('fetch', makeGeminiMock())
  })

  it('addModel registers pricing for a new model on existing provider', () => {
    router.addModel('google', 'gemini-new-model', { input: 0.5, output: 2.0 })
    // Should not throw — model is now allowed
    expect(() =>
      (router as unknown as { registry: { isModelAllowed: (p: string, m: string) => boolean } })
        .registry.isModelAllowed('google', 'gemini-new-model')
    ).not.toThrow()
  })

  it('emits model:added event', () => {
    const handler = vi.fn()
    router.on('model:added', handler)
    router.addModel('google', 'gemini-test', { input: 1, output: 1 })
    expect(handler).toHaveBeenCalledOnce()
    expect(handler.mock.calls[0]?.[0]).toMatchObject({ providerName: 'google', modelId: 'gemini-test' })
  })

  it('removeModel blocks future requests for that model', async () => {
    router.setKey('u1', 'google', 'fake-key')
    router.removeModel('google', 'gemini-2.0-flash')
    await expect(
      router.chat('u1', {
        model: 'gemini-2.0-flash',
        messages: [{ role: 'user', content: 'hi' }],
      })
    ).rejects.toThrow('removed')
  })

  it('emits model:removed event', () => {
    const handler = vi.fn()
    router.on('model:removed', handler)
    router.removeModel('google', 'gemini-2.0-flash')
    expect(handler).toHaveBeenCalledOnce()
  })

  it('on() returns an unsubscribe function that works', async () => {
    const handler = vi.fn()
    const unsub = router.on('provider:added', handler)
    await router.addProvider('p1', () => new MockProvider('p1'), [])
    expect(handler).toHaveBeenCalledOnce()

    unsub()
    await router.addProvider('p2', () => new MockProvider('p2'), [])
    expect(handler).toHaveBeenCalledOnce() // not called again
  })
})

describe('Plugin system', () => {
  it('use() calls plugin.install()', () => {
    const router = new FreeRouter({ audit: { enabled: false } })
    const install = vi.fn()
    router.use({ name: 'test-plugin', install })
    expect(install).toHaveBeenCalledWith(router)
  })

  it('use() deduplicates by name', () => {
    const router = new FreeRouter({ audit: { enabled: false } })
    const install = vi.fn()
    const plugin = { name: 'dedup-plugin', install }
    router.use(plugin).use(plugin)
    expect(install).toHaveBeenCalledOnce()
  })

  it('use() returns this for chaining', () => {
    const router = new FreeRouter({ audit: { enabled: false } })
    const result = router.use({ name: 'chain-plugin', install: vi.fn() })
    expect(result).toBe(router)
  })
})

describe('Health & Metrics', () => {
  it('healthCheck() returns healthy when all providers available', () => {
    const router = new FreeRouter({ audit: { enabled: false } })
    const health = router.healthCheck()
    expect(health.status).toBe('healthy')
    expect(health.providers.length).toBeGreaterThan(0)
    expect(health.uptime).toBeGreaterThanOrEqual(0)
  })

  it('healthCheck() returns degraded after a provider is removed', async () => {
    const router = new FreeRouter({ audit: { enabled: false } })
    await router.removeProvider('groq', { force: true })
    const health = router.healthCheck()
    expect(health.status).toBe('degraded')
    const groqEntry = health.providers.find(p => p.name === 'groq')
    expect(groqEntry?.available).toBe(false)
  })

  it('metrics() returns zero-counts for a fresh router', () => {
    const router = new FreeRouter({ audit: { enabled: false } })
    const m = router.metrics()
    expect(m.requests.total).toBe(0)
    expect(m.errorRate).toBe(0)
    expect(m.spend.totalUsd).toBe(0)
  })

  it('metrics() increments after a chat request', async () => {
    const router = new FreeRouter({ masterKey, audit: { enabled: false } })
    vi.stubGlobal('fetch', makeGeminiMock())
    router.setKey('u1', 'google', 'key')
    await router.chat('u1', { model: 'gemini-2.0-flash', messages: [{ role: 'user', content: 'hi' }] })
    const m = router.metrics()
    expect(m.requests.total).toBeGreaterThan(0)
    expect(m.spend.totalUsd).toBeGreaterThanOrEqual(0)
  })
})
