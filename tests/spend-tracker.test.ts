import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SpendTracker } from '../src/finops/spend-tracker.js'
import type { BudgetPolicy, SpendRecord } from '../src/types.js'

const makeRecord = (userId: string, costUsd: number, override: Partial<SpendRecord> = {}): SpendRecord => ({
  userId,
  provider: 'google',
  model: 'gemini-2.0-flash',
  tokens: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
  costUsd,
  timestamp: Date.now(),
  ...override,
})

describe('SpendTracker', () => {
  let tracker: SpendTracker

  beforeEach(() => {
    tracker = new SpendTracker()
  })

  it('aggregates spend per user scope', () => {
    tracker.recordSpend(makeRecord('user1', 0.50))
    tracker.recordSpend(makeRecord('user1', 0.30))
    tracker.recordSpend(makeRecord('user2', 0.10))

    const summary = tracker.getSpend({ type: 'user', userId: 'user1' }, 'daily')
    expect(summary.spendUsd).toBeCloseTo(0.80, 4)
    expect(summary.requests).toBe(2)
  })

  it('aggregates at org scope', () => {
    tracker.recordSpend(makeRecord('user1', 1.00, { orgId: 'org1' }))
    tracker.recordSpend(makeRecord('user2', 2.00, { orgId: 'org1' }))
    tracker.recordSpend(makeRecord('user3', 5.00, { orgId: 'org2' }))

    const summary = tracker.getSpend({ type: 'org', orgId: 'org1' }, 'daily')
    expect(summary.spendUsd).toBeCloseTo(3.00, 4)
  })

  it('blocks request when budget exceeded', () => {
    tracker.recordSpend(makeRecord('user1', 9.99))

    const policy: BudgetPolicy = {
      id: 'p1',
      scope: { type: 'user', userId: 'user1' },
      window: 'daily',
      maxSpendUsd: 10.00,
      onLimitReached: 'block',
    }

    const result = tracker.checkPolicies({
      userId: 'user1',
      model: 'gemini-2.0-flash',
      estimatedCostUsd: 0.02,
      policies: [policy],
    })

    expect(result.allowed).toBe(false)
    expect(result.blockedReason).toContain('exceeded')
  })

  it('downgrades model when configured', () => {
    tracker.recordSpend(makeRecord('user1', 9.99))

    const policy: BudgetPolicy = {
      id: 'p2',
      scope: { type: 'user', userId: 'user1' },
      window: 'daily',
      maxSpendUsd: 10.00,
      onLimitReached: 'downgrade',
      fallbackModel: 'gemini-2.0-flash-lite',
    }

    const result = tracker.checkPolicies({
      userId: 'user1',
      model: 'gemini-2.5-pro',
      estimatedCostUsd: 0.02,
      policies: [policy],
    })

    expect(result.allowed).toBe(true)
    expect(result.downgradeTo).toBe('gemini-2.0-flash-lite')
  })

  it('fires budget:warning at threshold', () => {
    const handler = vi.fn()
    tracker.on('budget:warning', handler)
    tracker.recordSpend(makeRecord('user1', 8.5))

    const policy: BudgetPolicy = {
      id: 'p3',
      scope: { type: 'user', userId: 'user1' },
      window: 'daily',
      maxSpendUsd: 10.00,
      onLimitReached: 'warn',
      alertThresholds: [80],
    }

    tracker.checkPolicies({
      userId: 'user1',
      model: 'gemini-2.0-flash',
      estimatedCostUsd: 0.01,
      policies: [policy],
    })

    expect(handler).toHaveBeenCalledOnce()
  })

  it('respects per-model caps', () => {
    const policy: BudgetPolicy = {
      id: 'p4',
      scope: { type: 'user', userId: 'user1' },
      window: 'daily',
      maxSpendUsd: 100,
      onLimitReached: 'block',
      modelCaps: { 'gemini-2.5-pro': { maxSpendUsd: 1.00 } },
    }

    tracker.recordSpend(makeRecord('user1', 0.99, { model: 'gemini-2.5-pro' }))

    const result = tracker.checkPolicies({
      userId: 'user1',
      model: 'gemini-2.5-pro',
      estimatedCostUsd: 0.02,
      policies: [policy],
    })

    expect(result.allowed).toBe(false)
    expect(result.blockedReason).toContain('gemini-2.5-pro')
  })
})
