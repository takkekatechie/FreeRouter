import type { BudgetScope, ChargebackReport, TokenUsage } from '../types.js'
import type { SpendTracker } from './spend-tracker.js'

const ZERO_USAGE: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 }

function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    promptTokens:     a.promptTokens     + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    totalTokens:      a.totalTokens      + b.totalTokens,
  }
}

function addTo(map: Record<string, number>, key: string, value: number): void {
  map[key] = (map[key] ?? 0) + value
}

/**
 * Generates cost attribution reports for enterprise billing / ERP integration.
 */
export class ChargebackEngine {
  constructor(private readonly tracker: SpendTracker) {}

  generateReport(
    scope: BudgetScope,
    start: Date,
    end: Date,
  ): ChargebackReport {
    const startMs = start.getTime()
    const endMs   = end.getTime()

    const records = this.tracker.allRecords().filter(r => {
      if (r.timestamp < startMs || r.timestamp > endMs) return false
      switch (scope.type) {
        case 'global':     return true
        case 'org':        return r.orgId === scope.orgId
        case 'department': return r.orgId === scope.orgId && r.departmentId === scope.departmentId
        case 'team':       return r.orgId === scope.orgId && r.teamId === scope.teamId
        case 'user':       return r.userId === scope.userId
      }
    })

    const byProvider:   Record<string, number> = {}
    const byModel:      Record<string, number> = {}
    const byUser:       Record<string, number> = {}
    const byTeam:       Record<string, number> = {}
    const byDepartment: Record<string, number> = {}

    let totalSpendUsd = 0
    let totalTokens: TokenUsage = { ...ZERO_USAGE }

    for (const r of records) {
      totalSpendUsd += r.costUsd
      totalTokens = addUsage(totalTokens, r.tokens)

      addTo(byProvider, r.provider, r.costUsd)
      addTo(byModel,    r.model,    r.costUsd)
      addTo(byUser,     r.userId,   r.costUsd)
      if (r.teamId !== undefined)       addTo(byTeam,       r.teamId,       r.costUsd)
      if (r.departmentId !== undefined) addTo(byDepartment, r.departmentId, r.costUsd)
    }

    return {
      period: { start: startMs, end: endMs },
      scope,
      totalSpendUsd,
      totalTokens,
      byProvider,
      byModel,
      byUser,
      ...(Object.keys(byTeam).length > 0       && { byTeam }),
      ...(Object.keys(byDepartment).length > 0 && { byDepartment }),
    }
  }
}
