import type {
  BudgetPolicy,
  BudgetScope,
  BudgetWindow,
  SpendRecord,
  SpendSummary,
  TokenUsage,
} from '../types.js'

const WINDOW_MS: Record<BudgetWindow, number> = {
  hourly:    60 * 60 * 1_000,
  daily:     24 * 60 * 60 * 1_000,
  weekly:    7  * 24 * 60 * 60 * 1_000,
  monthly:   30 * 24 * 60 * 60 * 1_000,
  quarterly: 90 * 24 * 60 * 60 * 1_000,
  total:     Number.MAX_SAFE_INTEGER,
}

function scopeKey(scope: BudgetScope): string {
  switch (scope.type) {
    case 'global': return 'global'
    case 'org': return `org:${scope.orgId}`
    case 'department': return `dept:${scope.orgId}:${scope.departmentId}`
    case 'team': return `team:${scope.orgId}:${scope.teamId}`
    case 'user': return `user:${scope.userId}`
  }
}

function recordMatchesScope(record: SpendRecord, scope: BudgetScope): boolean {
  switch (scope.type) {
    case 'global':     return true
    case 'org':        return record.orgId === scope.orgId
    case 'department': return record.orgId === scope.orgId && record.departmentId === scope.departmentId
    case 'team':       return record.orgId === scope.orgId && record.teamId === scope.teamId
    case 'user':       return record.userId === scope.userId
  }
}

type EventType = 'budget:warning' | 'budget:exceeded' | 'budget:reset'
type EventHandler = (scope: BudgetScope, summary: SpendSummary, policyId?: string) => void

export class SpendTracker {
  private readonly records: SpendRecord[] = []
  private readonly handlers = new Map<EventType, EventHandler[]>()
  /** Track last seen % milestone per policy for de-dupe */
  private readonly alertState = new Map<string, number>()

  on(event: EventType, handler: EventHandler): void {
    const existing = this.handlers.get(event) ?? []
    this.handlers.set(event, [...existing, handler])
  }

  private emit(event: EventType, scope: BudgetScope, summary: SpendSummary, policyId?: string): void {
    const handlers = this.handlers.get(event) ?? []
    for (const h of handlers) h(scope, summary, policyId)
  }

  /** Record an actual spend after a completed request. */
  recordSpend(record: SpendRecord): void {
    this.records.push(record)
  }

  /**
   * Aggregate spending for a scope + window.
   */
  getSpend(scope: BudgetScope, window: BudgetWindow): SpendSummary {
    const cutoff = Date.now() - WINDOW_MS[window]
    const relevant = this.records.filter(
      r => r.timestamp >= cutoff && recordMatchesScope(r, scope),
    )

    const spendUsd = relevant.reduce((s, r) => s + r.costUsd, 0)
    const tokens: TokenUsage = {
      promptTokens: relevant.reduce((s, r) => s + r.tokens.promptTokens, 0),
      completionTokens: relevant.reduce((s, r) => s + r.tokens.completionTokens, 0),
      totalTokens: relevant.reduce((s, r) => s + r.tokens.totalTokens, 0),
    }

    return {
      scope,
      window,
      spendUsd,
      tokens,
      requests: relevant.length,
      periodStart: cutoff,
      periodEnd: Date.now(),
    }
  }

  /**
   * Check if a given spend increment is allowed by all applicable policies.
   * Returns the first blocking or warning policy found.
   */
  checkPolicies(params: {
    userId: string
    orgId?: string
    teamId?: string
    departmentId?: string
    model: string
    estimatedCostUsd: number
    policies: BudgetPolicy[]
  }): {
    allowed: boolean
    downgradeTo?: string
    warnings: string[]
    blockedReason?: string
    policyId?: string
  } & { action?: BudgetPolicy['onLimitReached'] } {
    const warnings: string[] = []
    const scopes = this.buildScopeChain(params)

    // Sort policies by priority descending
    const sorted = [...params.policies].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))

    for (const policy of sorted) {
      // Check if this policy applies to any scope in the chain
      const appliedScope = scopes.find(s => scopeKey(s) === scopeKey(policy.scope))
      if (appliedScope === undefined) continue

      const summary = this.getSpend(policy.scope, policy.window)
      const projected = summary.spendUsd + params.estimatedCostUsd

      // Check per-model cap
      if (policy.modelCaps) {
        const modelKey = Object.keys(policy.modelCaps).find(k => params.model.startsWith(k))
        if (modelKey !== undefined) {
          const cap = policy.modelCaps[modelKey]
          if (cap !== undefined && projected > cap.maxSpendUsd) {
            if (policy.onLimitReached === 'block') {
              return {
                allowed: false,
                blockedReason: `Model "${params.model}" cap of $${cap.maxSpendUsd.toFixed(4)} exceeded for policy "${policy.id}"`,
                policyId: policy.id,
                warnings,
                action: 'block',
              }
            }
          }
        }
      }

      // Check total spend cap
      if (projected > policy.maxSpendUsd) {
        this.emit('budget:exceeded', policy.scope, summary, policy.id)
        switch (policy.onLimitReached) {
          case 'block':
          case 'throttle':
            return {
              allowed: false,
              blockedReason: `Budget policy "${policy.id}" exceeded: $${projected.toFixed(4)} > $${policy.maxSpendUsd.toFixed(2)}`,
              policyId: policy.id,
              warnings,
              action: policy.onLimitReached,
            }
          case 'downgrade':
            warnings.push(`Budget policy "${policy.id}" exceeded — downgrading model`)
            return {
              allowed: true,
              ...(policy.fallbackModel !== undefined && { downgradeTo: policy.fallbackModel }),
              warnings,
              policyId: policy.id,
              action: 'downgrade' as const,
            }
          case 'warn':
          case 'notify':
            warnings.push(`Budget policy "${policy.id}" exceeded ($${projected.toFixed(4)} / $${policy.maxSpendUsd.toFixed(2)})`)
            break
        }
      }

      // Check alert thresholds
      if (policy.alertThresholds && policy.alertThresholds.length > 0) {
        const pct = (summary.spendUsd / policy.maxSpendUsd) * 100
        for (const threshold of policy.alertThresholds.sort((a, b) => b - a)) {
          const alertKey = `${policy.id}:${threshold}`
          const lastAlert = this.alertState.get(alertKey) ?? 0
          if (pct >= threshold && lastAlert < threshold) {
            this.alertState.set(alertKey, threshold)
            this.emit('budget:warning', policy.scope, summary, policy.id)
            warnings.push(`Budget policy "${policy.id}" is at ${pct.toFixed(1)}% of $${policy.maxSpendUsd.toFixed(2)}`)
          }
        }
      }
    }

    return { allowed: true, warnings }
  }

  private buildScopeChain(params: {
    userId: string
    orgId?: string
    teamId?: string
    departmentId?: string
  }): BudgetScope[] {
    const chain: BudgetScope[] = [
      { type: 'global' },
      { type: 'user', userId: params.userId },
    ]
    if (params.orgId !== undefined) {
      chain.push({ type: 'org', orgId: params.orgId })
      if (params.departmentId !== undefined) {
        chain.push({ type: 'department', orgId: params.orgId, departmentId: params.departmentId })
      }
      if (params.teamId !== undefined) {
        chain.push({ type: 'team', orgId: params.orgId, teamId: params.teamId })
      }
    }
    return chain
  }

  /** Prune records older than the maximum policy window to avoid memory growth */
  prune(maxWindowMs = WINDOW_MS.quarterly): void {
    const cutoff = Date.now() - maxWindowMs
    let i = 0
    while (i < this.records.length && (this.records[i]?.timestamp ?? 0) < cutoff) i++
    if (i > 0) this.records.splice(0, i)
  }

  /** All raw records (for chargeback / reporting) */
  allRecords(): readonly SpendRecord[] {
    return this.records
  }
}
