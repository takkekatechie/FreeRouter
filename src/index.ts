/**
 * FreeRouter — Public API barrel
 *
 * Import everything from 'freerouter'.
 * Sub-path imports available: 'freerouter/providers', 'freerouter/security', 'freerouter/finops', 'freerouter/adapters'
 */

// Main class
export { FreeRouter } from './router.js'

// Config
export type { RouterConfig, ProviderToggle } from './config.js'

// Config file loader
export { loadConfigFile, loadConfigFromEnv, mergeConfigs, validateConfigKeys } from './config-loader.js'
export type { FileConfig } from './config-loader.js'

// Config validator
export { validateConfig } from './config-validator.js'
export type { ConfigValidationResult } from './config-validator.js'

// Plugin
export type { FreeRouterPlugin } from './plugin.js'

// All shared types
export type {
  // Chat
  Message,
  ChatRequest,
  ChatResponse,
  TokenUsage,
  StreamChunk,
  RequestContext,

  // FinOps
  BudgetScope,
  BudgetWindow,
  BudgetPolicy,
  SpendSummary,
  SpendRecord,
  SpendForecast,
  ChargebackReport,
  RateLimitConfig,
  PolicyDecision,

  // Security
  AuditAction,
  AuditEntry,
  AuditSink,

  // Hot-reload lifecycle
  ModelPricingEntry,
  ProviderLifecycleEvent,
  ModelLifecycleEvent,
  RouterEventMap,

  // Health & Metrics
  ProviderHealth,
  HealthStatus,
  LatencyBuckets,
  RouterMetrics,
} from './types.js'

// Extensibility
export type { BaseProvider } from './providers/base-provider.js'
export type { KeyStore, StoredKey } from './security/key-manager.js'
export type { RateLimiterLike } from './finops/rate-limiter.js'
