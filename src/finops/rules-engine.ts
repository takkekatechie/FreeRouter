import type { ChatRequest, RequestContext } from '../types.js'
import type { CostStrategy } from './cost-router.js'

/**
 * Rule match predicate. All specified fields must match (AND).
 * String fields accept a single value or an array (one-of).
 * `modelPattern` supports `*` glob; `metadata` matches exact value or one-of array.
 */
export interface RuleMatch {
  userId?: string | string[]
  orgId?: string | string[]
  departmentId?: string | string[]
  teamId?: string | string[]
  /** Glob over `req.model`. Supports `*` wildcard, e.g. "openai/*". */
  modelPattern?: string
  priority?: 'realtime' | 'batch'
  /** Match on `req.metadata`. Each key must equal the value (or be one-of an array). */
  metadata?: Record<string, string | string[]>
}

export type RuleAction =
  | { type: 'pin'; model: string }
  | { type: 'strategy'; strategy: CostStrategy; candidateModels?: string[] }
  | { type: 'block'; reason: string }

export interface Rule {
  id: string
  /** Higher wins; default 0. Ties broken by array order. */
  priority?: number
  match: RuleMatch
  action: RuleAction
}

/** How rule decisions interact with the cost router. Admin chooses per deployment. */
export type RulesMode =
  | 'pin-wins'          // pin/strategy bypass or steer the cost router; block always blocks
  | 'narrow-candidates' // pin/strategy feed CostRouter as per-request overrides
  | 'post-override'     // CostRouter picks first; matching pin replaces the result

export interface RulesConfig {
  rules: Rule[]
  mode: RulesMode
}

export type RuleDecision =
  | { kind: 'pin'; model: string; ruleId: string }
  | { kind: 'strategy'; strategy: CostStrategy; candidateModels?: string[]; ruleId: string }
  | { kind: 'block'; reason: string; ruleId: string }
  | { kind: 'noop' }

/**
 * Pure in-memory admin rules engine. Sub-millisecond.
 *
 * Evaluates a request against an ordered rule list and emits a single decision.
 * First match by descending `priority` (then array order) wins.
 */
export class RulesEngine {
  private rules: Rule[] = []
  public readonly mode: RulesMode

  constructor(config: RulesConfig) {
    this.mode = config.mode
    this.replaceRules(config.rules)
  }

  /** Hot-reload entry point. Sorts rules by priority (desc) then by insertion order. */
  replaceRules(rules: Rule[]): void {
    const indexed = rules.map((rule, idx) => ({ rule, idx }))
    indexed.sort((a, b) => {
      const pa = a.rule.priority ?? 0
      const pb = b.rule.priority ?? 0
      if (pa !== pb) return pb - pa
      return a.idx - b.idx
    })
    this.rules = indexed.map(x => x.rule)
  }

  upsertRule(rule: Rule): void {
    const next = this.rules.filter(r => r.id !== rule.id)
    next.push(rule)
    this.replaceRules(next)
  }

  removeRule(id: string): void {
    this.replaceRules(this.rules.filter(r => r.id !== id))
  }

  list(): readonly Rule[] {
    return this.rules
  }

  evaluate(userId: string, req: ChatRequest, ctx: RequestContext): RuleDecision {
    for (const rule of this.rules) {
      if (!matches(rule.match, userId, req, ctx)) continue
      const a = rule.action
      if (a.type === 'pin') return { kind: 'pin', model: a.model, ruleId: rule.id }
      if (a.type === 'block') return { kind: 'block', reason: a.reason, ruleId: rule.id }
      return {
        kind: 'strategy',
        strategy: a.strategy,
        ...(a.candidateModels !== undefined && { candidateModels: a.candidateModels }),
        ruleId: rule.id,
      }
    }
    return { kind: 'noop' }
  }
}

// ── Matching helpers ─────────────────────────────────────────────────────────

function matches(m: RuleMatch, userId: string, req: ChatRequest, ctx: RequestContext): boolean {
  if (m.userId !== undefined && !inSet(userId, m.userId)) return false
  if (m.orgId !== undefined && (ctx.orgId === undefined || !inSet(ctx.orgId, m.orgId))) return false
  if (m.departmentId !== undefined && (ctx.departmentId === undefined || !inSet(ctx.departmentId, m.departmentId))) return false
  if (m.teamId !== undefined && (ctx.teamId === undefined || !inSet(ctx.teamId, m.teamId))) return false
  if (m.priority !== undefined && req.priority !== m.priority) return false
  if (m.modelPattern !== undefined && !globMatch(m.modelPattern, req.model)) return false
  if (m.metadata !== undefined) {
    const md = req.metadata
    if (md === undefined) return false
    for (const [key, expected] of Object.entries(m.metadata)) {
      const actual = md[key]
      if (typeof actual !== 'string') return false
      if (!inSet(actual, expected)) return false
    }
  }
  return true
}

function inSet(value: string, expected: string | string[]): boolean {
  return Array.isArray(expected) ? expected.includes(value) : expected === value
}

/** Minimal `*`-only glob matcher (no character classes). */
function globMatch(pattern: string, value: string): boolean {
  if (pattern === '*') return true
  if (!pattern.includes('*')) return pattern === value
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`).test(value)
}
