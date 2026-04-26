import { describe, it, expect } from 'vitest'
import { CostRouter } from '../src/finops/cost-router.js'
import { ProviderRegistry } from '../src/providers/registry.js'
import type { BaseProvider } from '../src/providers/base-provider.js'
import type { ChatRequest, ChatResponse, StreamChunk } from '../src/types.js'

// ── Minimal fake provider for pricing tests ─────────────────────────────────

function makeProvider(name: string, inputRate: number, outputRate = 1.0): BaseProvider {
  return {
    name,
    async chat(_req: ChatRequest, _key: string): Promise<ChatResponse> {
      return {
        id: 'x', model: name, content: '', provider: name,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        latencyMs: 0, finishedAt: Date.now(),
      }
    },
    async *chatStream(): AsyncIterable<StreamChunk> { yield { delta: '', done: true } },
    pricing: () => ({ input: inputRate, output: outputRate }),
  }
}

function makeRegistry(): ProviderRegistry {
  const registry = new ProviderRegistry([], {})
  // Register two cheap test providers
  registry.register(makeProvider('expensive', 10.0, 30.0)) // $10 / 1M input
  registry.register(makeProvider('medium', 3.0, 10.0))     // $3 / 1M input
  registry.register(makeProvider('cheap', 0.15, 0.60))     // $0.15 / 1M input
  return registry
}

describe('CostRouter', () => {
  const registry = makeRegistry()

  describe('strategy: performance', () => {
    it('always returns the requested model unchanged', () => {
      const router = new CostRouter(registry, {
        strategy: 'performance',
        candidateModels: ['cheap/model', 'medium/model'],
      })
      expect(router.selectModel('expensive/model', 10_000)).toBe('expensive/model')
    })

    it('ignores batchOnly when strategy is performance', () => {
      const router = new CostRouter(registry, {
        strategy: 'performance',
        candidateModels: ['cheap/model'],
        batchOnly: false,
      })
      expect(router.selectModel('expensive/model', 10_000, false)).toBe('expensive/model')
    })
  })

  describe('strategy: cheapest', () => {
    it('picks the lowest-cost candidate', () => {
      const router = new CostRouter(registry, {
        strategy: 'cheapest',
        candidateModels: ['medium/model', 'cheap/model'],
      })
      expect(router.selectModel('expensive/model', 100_000)).toBe('cheap/model')
    })

    it('returns original model when it is already cheapest', () => {
      const router = new CostRouter(registry, {
        strategy: 'cheapest',
        candidateModels: ['expensive/model', 'medium/model'],
      })
      expect(router.selectModel('cheap/model', 100_000)).toBe('cheap/model')
    })

    it('skips candidates that cannot be resolved by the registry', () => {
      const router = new CostRouter(registry, {
        strategy: 'cheapest',
        candidateModels: ['nonexistent/ghost', 'medium/model'],
      })
      // nonexistent/ghost is skipped; medium is cheaper than expensive
      expect(router.selectModel('expensive/model', 100_000)).toBe('medium/model')
    })

    it('returns original when candidateModels is empty', () => {
      const router = new CostRouter(registry, { strategy: 'cheapest', candidateModels: [] })
      expect(router.selectModel('expensive/model', 100_000)).toBe('expensive/model')
    })
  })

  describe('strategy: balanced — minCostThresholdUsd', () => {
    it('skips optimization for tiny requests below threshold', () => {
      const router = new CostRouter(registry, {
        strategy: 'cheapest',
        candidateModels: ['cheap/model'],
        minCostThresholdUsd: 1.00, // $1 threshold
      })
      // 1 token → cost ≈ $10 / 1M = $0.00001, well below $1
      expect(router.selectModel('expensive/model', 1)).toBe('expensive/model')
    })

    it('optimizes large requests above threshold', () => {
      const router = new CostRouter(registry, {
        strategy: 'cheapest',
        candidateModels: ['cheap/model'],
        minCostThresholdUsd: 0.0001, // small threshold
      })
      // 1M tokens → $10, well above threshold
      expect(router.selectModel('expensive/model', 1_000_000)).toBe('cheap/model')
    })
  })

  describe('batchOnly', () => {
    it('skips optimization for realtime requests when batchOnly is true', () => {
      const router = new CostRouter(registry, {
        strategy: 'cheapest',
        candidateModels: ['cheap/model'],
        batchOnly: true,
      })
      // isRealtime = true → no optimization
      expect(router.selectModel('expensive/model', 100_000, true)).toBe('expensive/model')
    })

    it('optimizes batch requests even with batchOnly true', () => {
      const router = new CostRouter(registry, {
        strategy: 'cheapest',
        candidateModels: ['cheap/model'],
        batchOnly: true,
      })
      // isRealtime = false → optimize
      expect(router.selectModel('expensive/model', 100_000, false)).toBe('cheap/model')
    })

    it('when batchOnly is false, optimizes all requests', () => {
      const router = new CostRouter(registry, {
        strategy: 'cheapest',
        candidateModels: ['cheap/model'],
        batchOnly: false,
      })
      expect(router.selectModel('expensive/model', 100_000, true)).toBe('cheap/model')
    })
  })

  describe('edge cases', () => {
    it('handles unresolvable requested model gracefully', () => {
      const router = new CostRouter(registry, {
        strategy: 'cheapest',
        candidateModels: ['cheap/model'],
      })
      // Unknown model — should not throw, returns original
      expect(router.selectModel('unknown/ghost', 100_000)).toBe('unknown/ghost')
    })

    it('selectModel is pure — repeated calls with same args return same result', () => {
      const router = new CostRouter(registry, {
        strategy: 'cheapest',
        candidateModels: ['medium/model', 'cheap/model'],
      })
      const a = router.selectModel('expensive/model', 50_000)
      const b = router.selectModel('expensive/model', 50_000)
      expect(a).toBe(b)
    })
  })
})
