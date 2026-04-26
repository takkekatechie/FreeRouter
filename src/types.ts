/**
 * FreeRouter — Shared type definitions
 * Provider-agnostic, zero-dependency.
 */

// ─────────────────────────────────────────
// Message + Request + Response
// ─────────────────────────────────────────

export interface Message {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatRequest {
  /** Provider-specific model identifier, e.g. "gemini-2.0-flash" */
  model: string
  messages: Message[]
  temperature?: number
  maxTokens?: number
  stream?: boolean
  /**
   * Request priority hint used by the CostRouter and rate limiter.
   * - 'realtime'  (default) — latency-sensitive; bypasses cost optimization when batchOnly is set.
   * - 'batch'     — non-latency-sensitive; eligible for model downgrade to a cheaper candidate.
   */
  priority?: 'realtime' | 'batch'
  /** Pass-through extras forwarded verbatim to the provider */
  metadata?: Record<string, unknown>
}

export interface TokenUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  /** Tokens served from the provider's prompt cache (subset of promptTokens). */
  cachedPromptTokens?: number
}

export interface ChatResponse {
  id: string
  model: string
  content: string
  usage: TokenUsage
  /** Wall-clock latency in milliseconds (router overhead + provider round-trip) */
  latencyMs: number
  provider: string
  finishedAt: number // epoch ms
}

export interface StreamChunk {
  delta: string
  done: boolean
  /** Only populated on the final chunk */
  usage?: TokenUsage
}

// ─────────────────────────────────────────
// Org / Request context
// ─────────────────────────────────────────

/**
 * Passed with each request to resolve hierarchical budgets.
 * All fields are optional — omit any tiers not applicable.
 */
export interface RequestContext {
  orgId?: string
  departmentId?: string
  teamId?: string
}

// ─────────────────────────────────────────
// FinOps — Budget scope hierarchy
// ─────────────────────────────────────────

export type BudgetScope =
  | { type: 'global' }
  | { type: 'org'; orgId: string }
  | { type: 'department'; orgId: string; departmentId: string }
  | { type: 'team'; orgId: string; teamId: string }
  | { type: 'user'; userId: string }

export type BudgetWindow =
  | 'hourly'
  | 'daily'
  | 'weekly'
  | 'monthly'
  | 'quarterly'
  | 'total'

export interface BudgetPolicy {
  id: string
  scope: BudgetScope
  window: BudgetWindow
  maxSpendUsd: number
  maxTokens?: number
  maxRequests?: number
  /** Per-model spend cap within this policy */
  modelCaps?: Record<string, { maxSpendUsd: number }>
  onLimitReached: 'block' | 'warn' | 'downgrade' | 'notify' | 'throttle'
  /** Required when onLimitReached === 'downgrade' */
  fallbackModel?: string
  /** Alert at these % thresholds, e.g. [50, 80, 95] */
  alertThresholds?: number[]
  /** Higher = evaluated first; default 0 */
  priority?: number
}

export interface SpendSummary {
  scope: BudgetScope
  window: BudgetWindow
  spendUsd: number
  tokens: TokenUsage
  requests: number
  periodStart: number
  periodEnd: number
}

export interface SpendRecord {
  userId: string
  orgId?: string
  departmentId?: string
  teamId?: string
  provider: string
  model: string
  tokens: TokenUsage
  costUsd: number
  timestamp: number // epoch ms
  /** Tokens served from provider cache — used to compute actual (discounted) cost. */
  cachedPromptTokens?: number
}

export interface SpendForecast {
  scope: BudgetScope
  window: BudgetWindow
  currentSpendUsd: number
  projectedSpendUsd: number
  projectedOverage: number
  /** USD per hour */
  burnRate: number
  /** Epoch ms when budget is predicted to be exhausted; undefined if on-track */
  estimatedBudgetExhaustionAt?: number
  recommendation: 'on-track' | 'at-risk' | 'over-budget'
}

export interface ChargebackReport {
  period: { start: number; end: number }
  scope: BudgetScope
  totalSpendUsd: number
  totalTokens: TokenUsage
  byProvider: Record<string, number>
  byModel: Record<string, number>
  byUser: Record<string, number>
  byTeam?: Record<string, number>
  byDepartment?: Record<string, number>
}

// ─────────────────────────────────────────
// FinOps — Rate limiting
// ─────────────────────────────────────────

export interface RateLimitConfig {
  requestsPerMinute: number
  tokensPerMinute?: number
  /** Fraction above nominal limit allowed in brief bursts; e.g. 0.2 = 20% burst */
  burstAllowance?: number
  scope?: BudgetScope
}

// ─────────────────────────────────────────
// Policy Engine
// ─────────────────────────────────────────

export interface PolicyDecision {
  allowed: boolean
  originalModel: string
  /** May differ from originalModel when downgraded */
  effectiveModel: string
  estimatedCostUsd: number
  warnings: string[]
  blockedReason?: string
  /** ID of the policy that triggered a block or downgrade */
  policyId?: string
  forecast?: SpendForecast
}

// ─────────────────────────────────────────
// Security / Audit
// ─────────────────────────────────────────

export type AuditAction =
  | 'key:set'
  | 'key:rotated'
  | 'key:deleted'
  | 'key:expired'
  | 'request:sent'
  | 'request:blocked'
  | 'budget:warning'
  | 'budget:exceeded'
  | 'forecast:at-risk'
  | 'policy:violated'
  | 'provider:added'
  | 'provider:removed'
  | 'model:added'
  | 'model:removed'

export interface AuditEntry {
  timestamp: number
  userId: string
  teamId?: string
  departmentId?: string
  orgId?: string
  action: AuditAction
  provider?: string
  model?: string
  costUsd?: number
  /** Human-readable reason for blocked/violated entries */
  reason?: string
  /** HMAC-SHA256 of request body — never raw content */
  requestHash?: string
  policyId?: string
  /** ID of the admin rule that pinned/blocked/steered this request, if any. */
  ruleId?: string
}

export interface AuditSink {
  write(entry: AuditEntry): void | Promise<void>
}

// ─────────────────────────────────────────
// Hot-reload — Provider / Model lifecycle
// ─────────────────────────────────────────

/** Pricing for a single model: USD per 1M tokens */
export interface ModelPricingEntry {
  input: number
  output: number
  /**
   * Price for prompt tokens served from the provider's cache (USD / 1M tokens).
   * Defaults to `input` when absent (no cache discount).
   * Anthropic: ~10 % of input. OpenAI: ~50 % of input.
   */
  cachedInput?: number
}

export interface ProviderLifecycleEvent {
  providerName: string
  timestamp: number
}

export interface ModelLifecycleEvent {
  providerName: string
  modelId: string
  timestamp: number
}

export type RouterEventMap = {
  'provider:added': ProviderLifecycleEvent
  'provider:removed': ProviderLifecycleEvent
  'model:added': ModelLifecycleEvent
  'model:removed': ModelLifecycleEvent
}

// ─────────────────────────────────────────
// Health & Metrics
// ─────────────────────────────────────────

export interface ProviderHealth {
  name: string
  /** false if runtime-blocked or unregistered */
  available: boolean
  /** Epoch ms of last failed request */
  lastErrorAt?: number
}

export interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy'
  providers: ProviderHealth[]
  /** Milliseconds since FreeRouter was instantiated */
  uptime: number
  timestamp: number
}

export interface LatencyBuckets {
  p50: number
  p95: number
  p99: number
}

export interface RouterMetrics {
  requests: {
    total: number
    succeeded: number
    failed: number
    blocked: number
  }
  latencyMs: LatencyBuckets
  errorRate: number
  spend: {
    totalUsd: number
    totalTokens: number
  }
  byProvider: Record<string, {
    requests: number
    errors: number
    totalCostUsd: number
  }>
}
