import type { AuditAction, AuditEntry, AuditSink } from '../types.js'

/**
 * Default sink: structured JSON to stdout.
 * Container-friendly — logs are never written to disk by FreeRouter itself.
 */
const stdoutSink: AuditSink = {
  write(entry: AuditEntry): void {
    process.stdout.write(JSON.stringify(entry) + '\n')
  },
}

/**
 * Immutable append-only audit logger.
 *
 * NEVER logs:
 *  - Raw API keys
 *  - Message content (only HMAC hashes)
 *  - Personal data beyond userId/teamId
 */
export class AuditLogger {
  private readonly enabled: boolean
  private readonly sink: AuditSink

  constructor(opts: { enabled: boolean; sink?: AuditSink } = { enabled: true }) {
    this.enabled = opts.enabled
    this.sink = opts.sink ?? stdoutSink
  }

  log(entry: Omit<AuditEntry, 'timestamp'>): void {
    if (!this.enabled) return
    const full: AuditEntry = { timestamp: Date.now(), ...entry }
    // Fire-and-forget but surface async errors as unhandled rejections
    const result = this.sink.write(full)
    if (result instanceof Promise) {
      result.catch((err: unknown) => {
        process.stderr.write(`[FreeRouter/AuditLogger] Sink error: ${String(err)}\n`)
      })
    }
  }

  /** Convenience wrappers */
  keySet(userId: string, provider: string, context?: { teamId?: string; orgId?: string }): void {
    this.log({ action: 'key:set', userId, provider, ...context })
  }

  keyRotated(userId: string, provider: string, context?: { teamId?: string; orgId?: string }): void {
    this.log({ action: 'key:rotated', userId, provider, ...context })
  }

  keyDeleted(userId: string, provider: string): void {
    this.log({ action: 'key:deleted', userId, provider })
  }

  keyExpired(userId: string, provider: string): void {
    this.log({ action: 'key:expired', userId, provider })
  }

  requestSent(params: {
    userId: string
    provider: string
    model: string
    costUsd: number
    requestHash?: string
    teamId?: string
    departmentId?: string
    orgId?: string
    policyId?: string
    ruleId?: string
  }): void {
    this.log({ action: 'request:sent', ...params })
  }

  requestBlocked(params: {
    userId: string
    provider?: string
    model: string
    reason: string
    policyId?: string
    teamId?: string
    orgId?: string
    ruleId?: string
  }): void {
    this.log({ action: 'request:blocked', ...params })
  }

  budgetWarning(params: {
    userId: string
    policyId: string
    costUsd: number
    reason: string
    teamId?: string
    orgId?: string
  }): void {
    this.log({ action: 'budget:warning', ...params })
  }

  budgetExceeded(params: {
    userId: string
    policyId: string
    costUsd: number
    reason: string
    teamId?: string
    orgId?: string
  }): void {
    this.log({ action: 'budget:exceeded', ...params })
  }

  policyViolated(params: {
    userId: string
    policyId: string
    reason: string
    model: string
    teamId?: string
    orgId?: string
  }): void {
    this.log({ action: 'policy:violated', ...params })
  }

  providerAdded(providerName: string): void {
    this.log({ action: 'provider:added', userId: 'system', provider: providerName })
  }

  providerRemoved(providerName: string): void {
    this.log({ action: 'provider:removed', userId: 'system', provider: providerName })
  }

  modelAdded(providerName: string, modelId: string): void {
    this.log({ action: 'model:added', userId: 'system', provider: providerName, model: modelId })
  }

  modelRemoved(providerName: string, modelId: string): void {
    this.log({ action: 'model:removed', userId: 'system', provider: providerName, model: modelId })
  }
}

export type { AuditAction, AuditEntry, AuditSink }
