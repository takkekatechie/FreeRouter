import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { writeFile, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { FreeRouter } from '../src/router.js'
import { FileRulesSource } from '../src/adapters/file-rules-source.js'
import type { Rule } from '../src/finops/rules-engine.js'
import type { BaseProvider } from '../src/providers/base-provider.js'
import type { AuditEntry, AuditSink, ChatRequest, ChatResponse, StreamChunk } from '../src/types.js'

const masterKey = Buffer.alloc(32, 'r').toString('hex')

class FakeProvider implements BaseProvider {
  readonly name: string
  private readonly rate: number
  constructor(name: string, rate: number) {
    this.name = name
    this.rate = rate
  }
  async chat(req: ChatRequest, _k: string): Promise<ChatResponse> {
    return {
      id: 'x', model: req.model, content: 'ok', provider: this.name,
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      latencyMs: 1, finishedAt: Date.now(),
    }
  }
  async *chatStream(_req: ChatRequest, _k: string): AsyncIterable<StreamChunk> {
    yield { delta: '', done: true, usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } }
  }
  pricing(_model: string) { return { input: this.rate, output: this.rate * 3 } }
}

function makeRouter(opts: Partial<Parameters<typeof FreeRouter['prototype']['constructor']>[0]> = {}, audits?: AuditEntry[]) {
  const sink: AuditSink = { write: e => { audits?.push(e) } }
  const router = new FreeRouter({
    masterKey,
    audit: { enabled: audits !== undefined, sink },
    ...opts,
  })
  router.registerProvider(new FakeProvider('expensive', 10.0))
  router.registerProvider(new FakeProvider('medium', 3.0))
  router.registerProvider(new FakeProvider('cheap', 0.15))
  router.setKey('u1', 'expensive', 'k')
  router.setKey('u1', 'medium', 'k')
  router.setKey('u1', 'cheap', 'k')
  return router
}

const req: ChatRequest = { model: 'expensive/m', messages: [{ role: 'user', content: 'hello world' }] }

// ── Mode: pin-wins ──────────────────────────────────────────────────────────

describe('Router rules — mode: pin-wins', () => {
  it('pin overrides cost optimization (cheap candidate ignored)', async () => {
    const router = makeRouter({
      costOptimization: { strategy: 'cheapest', candidateModels: ['cheap/m'] },
      rules: {
        mode: 'pin-wins',
        rules: [{ id: 'r1', match: { userId: 'u1' }, action: { type: 'pin', model: 'medium/m' } }],
      },
    })
    const res = await router.chat('u1', req)
    expect(res.provider).toBe('medium')
  })

  it('strategy override applies the rule strategy', async () => {
    const router = makeRouter({
      costOptimization: { strategy: 'performance', candidateModels: ['cheap/m'] },
      rules: {
        mode: 'pin-wins',
        rules: [{ id: 'r1', match: { teamId: 't1' }, action: { type: 'strategy', strategy: 'cheapest' } }],
      },
    })
    const res = await router.chat('u1', req, { teamId: 't1' })
    expect(res.provider).toBe('cheap')
  })

  it('block throws and audits with ruleId', async () => {
    const audits: AuditEntry[] = []
    const router = makeRouter({
      rules: {
        mode: 'pin-wins',
        rules: [{ id: 'no-contractors', match: { orgId: 'contractors' }, action: { type: 'block', reason: 'policy' } }],
      },
    }, audits)
    await expect(router.chat('u1', req, { orgId: 'contractors' })).rejects.toThrow(/Request blocked by rule/)
    const blocked = audits.find(a => a.action === 'request:blocked')
    expect(blocked?.ruleId).toBe('no-contractors')
  })

  it('noop falls through to cost optimization', async () => {
    const router = makeRouter({
      costOptimization: { strategy: 'cheapest', candidateModels: ['cheap/m'] },
      rules: {
        mode: 'pin-wins',
        rules: [{ id: 'r1', match: { userId: 'someoneElse' }, action: { type: 'pin', model: 'medium/m' } }],
      },
    })
    const res = await router.chat('u1', req)
    expect(res.provider).toBe('cheap')
  })
})

// ── Mode: narrow-candidates ─────────────────────────────────────────────────

describe('Router rules — mode: narrow-candidates', () => {
  it('pin acts as candidate-set-of-one for cost router', async () => {
    const router = makeRouter({
      costOptimization: { strategy: 'cheapest', candidateModels: ['cheap/m'] },
      rules: {
        mode: 'narrow-candidates',
        rules: [{ id: 'r1', match: { userId: 'u1' }, action: { type: 'pin', model: 'medium/m' } }],
      },
    })
    // medium is cheaper than expensive — gets selected
    const res = await router.chat('u1', req)
    expect(res.provider).toBe('medium')
  })
})

// ── Mode: post-override ─────────────────────────────────────────────────────

describe('Router rules — mode: post-override', () => {
  it('pin replaces cost router result', async () => {
    const router = makeRouter({
      costOptimization: { strategy: 'cheapest', candidateModels: ['cheap/m'] },
      rules: {
        mode: 'post-override',
        rules: [{ id: 'r1', match: { userId: 'u1' }, action: { type: 'pin', model: 'medium/m' } }],
      },
    })
    const res = await router.chat('u1', req)
    expect(res.provider).toBe('medium')
  })
})

// ── Audit ───────────────────────────────────────────────────────────────────

describe('Router rules — audit', () => {
  it('request:sent audit entry includes ruleId for matched requests', async () => {
    const audits: AuditEntry[] = []
    const router = makeRouter({
      rules: {
        mode: 'pin-wins',
        rules: [{ id: 'legal-pin', match: { teamId: 'legal' }, action: { type: 'pin', model: 'medium/m' } }],
      },
    }, audits)
    await router.chat('u1', req, { teamId: 'legal' })
    const sent = audits.find(a => a.action === 'request:sent')
    expect(sent?.ruleId).toBe('legal-pin')
  })

  it('request:sent has no ruleId when no rule matches', async () => {
    const audits: AuditEntry[] = []
    const router = makeRouter({
      rules: {
        mode: 'pin-wins',
        rules: [{ id: 'r1', match: { teamId: 'legal' }, action: { type: 'pin', model: 'medium/m' } }],
      },
    }, audits)
    await router.chat('u1', req)
    const sent = audits.find(a => a.action === 'request:sent')
    expect(sent?.ruleId).toBeUndefined()
  })
})

// ── Runtime API ─────────────────────────────────────────────────────────────

describe('Router rules — runtime API', () => {
  it('setRule() and removeRule() mutate the active rule set', async () => {
    const router = makeRouter({
      rules: { mode: 'pin-wins', rules: [] },
    })
    // No rule yet — original model goes through
    const r1 = await router.chat('u1', req)
    expect(r1.provider).toBe('expensive')

    router.setRule({ id: 'pinx', match: { userId: 'u1' }, action: { type: 'pin', model: 'cheap/m' } })
    const r2 = await router.chat('u1', req)
    expect(r2.provider).toBe('cheap')

    router.removeRule('pinx')
    const r3 = await router.chat('u1', req)
    expect(r3.provider).toBe('expensive')
  })

  it('listRules() returns the current set sorted by priority', () => {
    const router = makeRouter({
      rules: {
        mode: 'pin-wins',
        rules: [
          { id: 'low', priority: 0, match: { userId: 'u1' }, action: { type: 'pin', model: 'a/x' } },
          { id: 'high', priority: 10, match: { userId: 'u1' }, action: { type: 'pin', model: 'b/y' } },
        ],
      },
    })
    const rules = router.listRules()
    expect(rules[0]?.id).toBe('high')
    expect(rules[1]?.id).toBe('low')
  })

  it('setRule() throws when rules engine is not configured', () => {
    const router = makeRouter({})
    expect(() => router.setRule({ id: 'r', match: {}, action: { type: 'pin', model: 'x/y' } }))
      .toThrow(/not configured/)
  })
})

// ── refreshRules() with FileRulesSource ─────────────────────────────────────

describe('Router rules — refreshRules() with FileRulesSource', () => {
  let dir: string
  let filePath: string

  beforeEach(async () => {
    dir = join(tmpdir(), `fr-rr-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await mkdir(dir, { recursive: true })
    filePath = join(dir, 'rules.json')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('loads rules from FileRulesSource on init() and re-applies on refreshRules()', async () => {
    const v1: Rule[] = [{ id: 'r1', match: { userId: 'u1' }, action: { type: 'pin', model: 'medium/m' } }]
    await writeFile(filePath, JSON.stringify(v1), 'utf8')

    const router = makeRouter({
      rules: { mode: 'pin-wins', rules: [] },
      rulesRefresh: { source: new FileRulesSource(filePath) },
    })
    await router.init()

    const r1 = await router.chat('u1', req)
    expect(r1.provider).toBe('medium')

    // Hot-swap
    const v2: Rule[] = [{ id: 'r1', match: { userId: 'u1' }, action: { type: 'pin', model: 'cheap/m' } }]
    await writeFile(filePath, JSON.stringify(v2), 'utf8')
    await router.refreshRules()

    const r2 = await router.chat('u1', req)
    expect(r2.provider).toBe('cheap')
  })

  it('onRulesRefreshed callback fires with rule count', async () => {
    const rules: Rule[] = [
      { id: 'r1', match: { userId: 'u1' }, action: { type: 'pin', model: 'cheap/m' } },
      { id: 'r2', match: { userId: 'u2' }, action: { type: 'block', reason: 'no' } },
    ]
    await writeFile(filePath, JSON.stringify(rules), 'utf8')

    let callbackCount: number | undefined
    const router = makeRouter({
      rules: { mode: 'pin-wins', rules: [] },
      rulesRefresh: { source: new FileRulesSource(filePath) },
      onRulesRefreshed: n => { callbackCount = n },
    })
    await router.init()
    expect(callbackCount).toBe(2)
  })
})

// ── Rules + cost optimization composition ───────────────────────────────────

describe('Router rules — composition with cost optimization', () => {
  it('strategy rule narrows candidate set for cost router', async () => {
    const router = makeRouter({
      costOptimization: { strategy: 'cheapest', candidateModels: ['medium/m', 'cheap/m'] },
      rules: {
        mode: 'pin-wins',
        rules: [
          // Restrict legal team to medium-tier candidates only
          { id: 'legal', match: { teamId: 'legal' }, action: { type: 'strategy', strategy: 'cheapest', candidateModels: ['medium/m'] } },
        ],
      },
    })
    // Without rule: cheap/m wins. With rule: candidate set is just [medium/m].
    const res = await router.chat('u1', req, { teamId: 'legal' })
    expect(res.provider).toBe('medium')
  })
})
