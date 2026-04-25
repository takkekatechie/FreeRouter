/**
 * FreeRouter — Public API barrel
 *
 * Import everything from 'freerouter'.
 * Sub-path imports available: 'freerouter/providers', 'freerouter/security', 'freerouter/finops'
 */

// Main class
export { FreeRouter } from './router.js'

// Config
export type { RouterConfig, ProviderToggle } from './config.js'

// Config file loader
export { loadConfigFile, loadConfigFromEnv, mergeConfigs, validateConfigKeys } from './config-loader.js'
export type { FileConfig } from './config-loader.js'

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
} from './types.js'

// Extensibility
export type { BaseProvider } from './providers/base-provider.js'
export type { KeyStore } from './security/key-manager.js'
