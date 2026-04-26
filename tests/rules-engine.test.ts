import { describe, it, expect } from 'vitest'
import { RulesEngine, type Rule } from '../src/finops/rules-engine.js'
import type { ChatRequest, RequestContext } from '../src/types.js'

const req = (overrides: Partial<ChatRequest> = {}): ChatRequest => ({
  model: 'openai/gpt-4o',
  messages: [{ role: 'user', content: 'hi' }],
  ...overrides,
})

describe('RulesEngine — matching', () => {
  it('returns noop when no rules match', () => {
    const engine = new RulesEngine({ mode: 'pin-wins', rules: [] })
    expect(engine.evaluate('u1', req(), {}).kind).toBe('noop')
  })

  it('matches by userId (single value)', () => {
    const engine = new RulesEngine({
      mode: 'pin-wins',
      rules: [{ id: 'r1', match: { userId: 'alice' }, action: { type: 'pin', model: 'anthropic/claude-3-5-sonnet' } }],
    })
    const decision = engine.evaluate('alice', req(), {})
    expect(decision.kind).toBe('pin')
    if (decision.kind === 'pin') expect(decision.model).toBe('anthropic/claude-3-5-sonnet')
    expect(engine.evaluate('bob', req(), {}).kind).toBe('noop')
  })

  it('matches by userId array (one-of)', () => {
    const engine = new RulesEngine({
      mode: 'pin-wins',
      rules: [{ id: 'r1', match: { userId: ['alice', 'bob'] }, action: { type: 'block', reason: 'no' } }],
    })
    expect(engine.evaluate('alice', req(), {}).kind).toBe('block')
    expect(engine.evaluate('bob', req(), {}).kind).toBe('block')
    expect(engine.evaluate('charlie', req(), {}).kind).toBe('noop')
  })

  it('matches by orgId/teamId/departmentId', () => {
    const engine = new RulesEngine({
      mode: 'pin-wins',
      rules: [
        { id: 'r1', match: { orgId: 'acme', teamId: 'legal' }, action: { type: 'pin', model: 'anthropic/claude-3-5-sonnet' } },
      ],
    })
    const ctx: RequestContext = { orgId: 'acme', teamId: 'legal' }
    expect(engine.evaluate('u1', req(), ctx).kind).toBe('pin')
    // Missing teamId — should not match
    expect(engine.evaluate('u1', req(), { orgId: 'acme' }).kind).toBe('noop')
    expect(engine.evaluate('u1', req(), { orgId: 'other', teamId: 'legal' }).kind).toBe('noop')
  })

  it('matches by metadata exact and one-of', () => {
    const engine = new RulesEngine({
      mode: 'pin-wins',
      rules: [
        { id: 'r1', match: { metadata: { useCase: ['code-review', 'analysis'] } }, action: { type: 'strategy', strategy: 'performance' } },
      ],
    })
    expect(engine.evaluate('u1', req({ metadata: { useCase: 'code-review' } }), {}).kind).toBe('strategy')
    expect(engine.evaluate('u1', req({ metadata: { useCase: 'summarization' } }), {}).kind).toBe('noop')
    expect(engine.evaluate('u1', req(), {}).kind).toBe('noop') // no metadata
  })

  it('matches by priority', () => {
    const engine = new RulesEngine({
      mode: 'pin-wins',
      rules: [{ id: 'r1', match: { priority: 'batch' }, action: { type: 'strategy', strategy: 'cheapest' } }],
    })
    expect(engine.evaluate('u1', req({ priority: 'batch' }), {}).kind).toBe('strategy')
    expect(engine.evaluate('u1', req({ priority: 'realtime' }), {}).kind).toBe('noop')
  })

  it('matches by modelPattern glob', () => {
    const engine = new RulesEngine({
      mode: 'pin-wins',
      rules: [
        { id: 'oa', match: { modelPattern: 'openai/*' }, action: { type: 'pin', model: 'anthropic/claude-3-haiku' } },
        { id: 'g4', match: { modelPattern: '*/gpt-4o' }, action: { type: 'block', reason: 'cost cap' }, priority: 10 },
      ],
    })
    // gpt-4o triggers the higher-priority block
    expect(engine.evaluate('u1', req({ model: 'openai/gpt-4o' }), {}).kind).toBe('block')
    // gpt-4o-mini matches openai/*
    const d = engine.evaluate('u1', req({ model: 'openai/gpt-4o-mini' }), {})
    expect(d.kind).toBe('pin')
  })
})

describe('RulesEngine — priority and ordering', () => {
  it('higher priority wins over earlier-listed rule', () => {
    const rules: Rule[] = [
      { id: 'low', priority: 0, match: { userId: 'u1' }, action: { type: 'pin', model: 'a/x' } },
      { id: 'high', priority: 10, match: { userId: 'u1' }, action: { type: 'pin', model: 'b/y' } },
    ]
    const engine = new RulesEngine({ mode: 'pin-wins', rules })
    const d = engine.evaluate('u1', req(), {})
    expect(d.kind === 'pin' && d.ruleId).toBe('high')
  })

  it('with equal priority, first declared wins', () => {
    const engine = new RulesEngine({
      mode: 'pin-wins',
      rules: [
        { id: 'a', match: { userId: 'u1' }, action: { type: 'pin', model: 'a/x' } },
        { id: 'b', match: { userId: 'u1' }, action: { type: 'pin', model: 'b/y' } },
      ],
    })
    const d = engine.evaluate('u1', req(), {})
    expect(d.kind === 'pin' && d.ruleId).toBe('a')
  })
})

describe('RulesEngine — runtime mutation', () => {
  it('replaceRules() swaps the rule set atomically', () => {
    const engine = new RulesEngine({
      mode: 'pin-wins',
      rules: [{ id: 'r1', match: { userId: 'u1' }, action: { type: 'pin', model: 'a/x' } }],
    })
    expect(engine.evaluate('u1', req(), {}).kind).toBe('pin')

    engine.replaceRules([{ id: 'r2', match: { userId: 'u1' }, action: { type: 'block', reason: 'frozen' } }])
    expect(engine.evaluate('u1', req(), {}).kind).toBe('block')
  })

  it('upsertRule() replaces same-id and adds new', () => {
    const engine = new RulesEngine({ mode: 'pin-wins', rules: [] })
    engine.upsertRule({ id: 'r1', match: { userId: 'u1' }, action: { type: 'pin', model: 'a/x' } })
    expect(engine.list()).toHaveLength(1)

    engine.upsertRule({ id: 'r1', match: { userId: 'u1' }, action: { type: 'block', reason: 'updated' } })
    expect(engine.list()).toHaveLength(1)
    expect(engine.evaluate('u1', req(), {}).kind).toBe('block')
  })

  it('removeRule() deletes by id', () => {
    const engine = new RulesEngine({
      mode: 'pin-wins',
      rules: [{ id: 'r1', match: { userId: 'u1' }, action: { type: 'block', reason: 'no' } }],
    })
    engine.removeRule('r1')
    expect(engine.evaluate('u1', req(), {}).kind).toBe('noop')
  })
})
