import type { ChatRequest } from '../types.js'

/**
 * Known prompt injection patterns (heuristic, not exhaustive).
 * Applied after unicode normalization.
 */
const INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(all\s+)?(previous|prior|above)\s+instructions?/i,
  /disregard\s+(the\s+)?(previous|prior|above|system)\s+(prompt|instructions?)/i,
  /you\s+are\s+now\s+(?:a|an)\s+/i,
  /your\s+new\s+(role|identity|persona)\s+is/i,
  /act\s+as\s+(if\s+you\s+are|a|an)\s+/i,
  /system\s+prompt\s*[:\-]/i,
  /<\|system\|>/i,
  /\[INST\]/i,
  /###\s*(?:system|instruction)/i,
  /roleplay\s+as/i,
  /pretend\s+you\s+(are|have\s+no)/i,
  /jailbreak/i,
  // Base64-encoded "ignore" variants (common obfuscation)
  /aWdub3Jl/i,
  // URL-encoded injection attempt
  /%69%67%6e%6f%72%65/i,
]

const NESTED_ENCODING_PATTERNS: RegExp[] = [
  // HTML entity encoding of angle brackets
  /&lt;[^&]+&gt;/i,
  // Unicode escape sequences for common injection chars
  /\\u00[34][0-9a-f]/i,
]

export class InputValidator {
  private readonly maxInputLength: number
  private readonly injectionGuard: boolean
  private readonly allowedModels: Set<string>

  constructor(opts: {
    maxInputLength?: number
    promptInjectionGuard?: boolean
    allowedModels?: string[]
  } = {}) {
    this.maxInputLength = opts.maxInputLength ?? 100_000
    this.injectionGuard = opts.promptInjectionGuard !== false // default true
    this.allowedModels = new Set(opts.allowedModels ?? [])
  }

  /**
   * Validate a chat request.
   * Throws a descriptive Error on any violation.
   */
  validate(req: ChatRequest): void {
    this.validateModel(req.model)
    this.validateMessages(req)
  }

  private validateModel(model: string): void {
    if (this.allowedModels.size > 0) {
      // Strip provider prefix for comparison
      const bare = model.includes('/') ? model.split('/')[1] : model
      if (bare === undefined || !this.isModelAllowed(bare, model)) {
        throw new Error(
          `[FreeRouter/InputValidator] Model "${model}" is not in the allowed model list.`,
        )
      }
    }
  }

  private isModelAllowed(bare: string, full: string): boolean {
    for (const allowed of this.allowedModels) {
      if (full === allowed || bare === allowed || full.startsWith(allowed) || bare.startsWith(allowed)) {
        return true
      }
    }
    return false
  }

  private validateMessages(req: ChatRequest): void {
    let totalLength = 0
    for (const msg of req.messages) {
      totalLength += msg.content.length
      if (totalLength > this.maxInputLength) {
        throw new Error(
          `[FreeRouter/InputValidator] Total input length (${totalLength}) exceeds maximum (${this.maxInputLength} chars).`,
        )
      }

      if (this.injectionGuard) {
        this.scanForInjection(msg.content)
      }
    }
  }

  private scanForInjection(content: string): void {
    // Normalize unicode to detect homoglyph attacks
    const normalized = content.normalize('NFKD')

    for (const pattern of INJECTION_PATTERNS) {
      if (pattern.test(normalized) || pattern.test(content)) {
        throw new Error(
          `[FreeRouter/InputValidator] Potential prompt injection detected. ` +
          `If this is a false positive, disable promptInjectionGuard in config.`,
        )
      }
    }

    for (const pattern of NESTED_ENCODING_PATTERNS) {
      if (pattern.test(content)) {
        throw new Error(
          `[FreeRouter/InputValidator] Encoded injection pattern detected in message content.`,
        )
      }
    }
  }
}
