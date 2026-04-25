/**
 * Zero-dependency structural validator for RouterConfig.
 * Catches misconfigured budgets, invalid keys, and type errors at startup.
 */

const KNOWN_TOP_LEVEL_KEYS = new Set([
  'masterKey', 'defaultProvider', 'defaultModel',
  'rateLimit', 'budgets', 'allowedModels', 'blockedProviders',
  'maxInputLength', 'promptInjectionGuard', 'requestSigning',
  'keyExpiryMs', 'audit', 'providers', 'pricingOverrides',
  'onBudgetWarning', 'onBudgetExceeded', 'onForecastAtRisk', 'onRequestComplete',
])

const VALID_BUDGET_WINDOWS = new Set([
  'hourly', 'daily', 'weekly', 'monthly', 'quarterly', 'total',
])

const VALID_LIMIT_ACTIONS = new Set([
  'block', 'warn', 'downgrade', 'notify', 'throttle',
])

const VALID_SCOPE_TYPES = new Set([
  'global', 'org', 'department', 'team', 'user',
])

export interface ConfigValidationResult {
  valid: boolean
  errors: string[]
  warnings: string[]
}

function isObject(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val)
}

export function validateConfig(config: unknown): ConfigValidationResult {
  const errors: string[] = []
  const warnings: string[] = []

  if (!isObject(config)) {
    return { valid: false, errors: ['Config must be a non-null object'], warnings: [] }
  }

  // Unknown top-level keys
  for (const key of Object.keys(config)) {
    if (!KNOWN_TOP_LEVEL_KEYS.has(key)) {
      warnings.push(`Unknown config key "${key}" — possible typo`)
    }
  }

  // masterKey
  if (config['masterKey'] !== undefined) {
    const mk = config['masterKey']
    if (typeof mk === 'string') {
      if (!/^[0-9a-fA-F]{64}$/.test(mk)) {
        errors.push('masterKey must be a 64-character hex string (32 bytes)')
      }
    } else if (!Buffer.isBuffer(mk)) {
      errors.push('masterKey must be a 64-char hex string or a Buffer')
    }
  }

  // rateLimit
  if (config['rateLimit'] !== undefined) {
    const rl = config['rateLimit']
    if (!isObject(rl)) {
      errors.push('rateLimit must be an object')
    } else {
      const rpm = rl['requestsPerMinute']
      if (typeof rpm !== 'number' || !Number.isInteger(rpm) || rpm <= 0) {
        errors.push('rateLimit.requestsPerMinute must be a positive integer')
      }
      if (rl['tokensPerMinute'] !== undefined) {
        const tpm = rl['tokensPerMinute']
        if (typeof tpm !== 'number' || tpm <= 0) {
          errors.push('rateLimit.tokensPerMinute must be a positive number')
        }
      }
      if (rl['burstAllowance'] !== undefined) {
        const ba = rl['burstAllowance']
        if (typeof ba !== 'number' || ba < 0) {
          errors.push('rateLimit.burstAllowance must be a non-negative number')
        }
      }
    }
  }

  // budgets
  if (config['budgets'] !== undefined) {
    if (!Array.isArray(config['budgets'])) {
      errors.push('budgets must be an array')
    } else {
      for (let i = 0; i < config['budgets'].length; i++) {
        const b = config['budgets'][i]
        const prefix = `budgets[${i}]`
        if (!isObject(b)) {
          errors.push(`${prefix} must be an object`)
          continue
        }
        if (typeof b['id'] !== 'string' || b['id'] === '') {
          errors.push(`${prefix}.id must be a non-empty string`)
        }
        if (typeof b['maxSpendUsd'] !== 'number' || b['maxSpendUsd'] < 0) {
          errors.push(`${prefix}.maxSpendUsd must be a non-negative number`)
        }
        if (!VALID_BUDGET_WINDOWS.has(b['window'] as string)) {
          errors.push(`${prefix}.window must be one of: ${[...VALID_BUDGET_WINDOWS].join(', ')}`)
        }
        if (!VALID_LIMIT_ACTIONS.has(b['onLimitReached'] as string)) {
          errors.push(`${prefix}.onLimitReached must be one of: ${[...VALID_LIMIT_ACTIONS].join(', ')}`)
        }
        if (b['onLimitReached'] === 'downgrade' && typeof b['fallbackModel'] !== 'string') {
          errors.push(`${prefix}.fallbackModel is required when onLimitReached === 'downgrade'`)
        }
        if (isObject(b['scope'])) {
          if (!VALID_SCOPE_TYPES.has(b['scope']['type'] as string)) {
            errors.push(`${prefix}.scope.type must be one of: ${[...VALID_SCOPE_TYPES].join(', ')}`)
          }
        } else {
          errors.push(`${prefix}.scope must be an object with a type field`)
        }
      }
    }
  }

  // audit
  if (config['audit'] !== undefined) {
    const audit = config['audit']
    if (!isObject(audit)) {
      errors.push('audit must be an object')
    } else if (audit['enabled'] !== undefined && typeof audit['enabled'] !== 'boolean') {
      errors.push('audit.enabled must be a boolean')
    }
  }

  // maxInputLength
  if (config['maxInputLength'] !== undefined) {
    const mil = config['maxInputLength']
    if (typeof mil !== 'number' || mil <= 0) {
      errors.push('maxInputLength must be a positive number')
    }
  }

  // allowedModels / blockedProviders — must be string arrays
  for (const field of ['allowedModels', 'blockedProviders'] as const) {
    if (config[field] !== undefined) {
      if (!Array.isArray(config[field]) || !(config[field] as unknown[]).every(x => typeof x === 'string')) {
        errors.push(`${field} must be an array of strings`)
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
