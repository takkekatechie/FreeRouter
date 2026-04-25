import type { ChatRequest, ChatResponse, StreamChunk } from '../types.js'

export interface ProviderPricing {
  /** USD per 1 000 000 input tokens */
  input: number
  /** USD per 1 000 000 output tokens */
  output: number
}

/**
 * All provider adapters extend this class.
 * They receive the raw API key only during a call — never stored.
 */
export abstract class BaseProvider {
  abstract readonly name: string

  abstract chat(
    req: ChatRequest,
    apiKey: string,
  ): Promise<ChatResponse>

  abstract chatStream(
    req: ChatRequest,
    apiKey: string,
  ): AsyncIterable<StreamChunk>

  /**
   * Returns the pricing for the given model as USD per 1 M tokens.
   * Returns a conservative default when the model is unknown.
   */
  abstract pricing(model: string): ProviderPricing

  // ─── Shared helpers ─────────────────────────────────────────

  protected generateId(): string {
    return `fr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
  }

  protected elapsed(startMs: number): number {
    return Date.now() - startMs
  }

  /**
   * Throws a structured error with provider context.
   * Never includes the API key in the message.
   */
  protected async throwHttpError(
    resp: Response,
    provider: string,
  ): Promise<never> {
    let body = ''
    try {
      body = await resp.text()
    } catch {
      // ignore
    }
    throw new Error(
      `[FreeRouter/${provider}] HTTP ${resp.status} ${resp.statusText}: ${body.slice(0, 200)}`,
    )
  }
}
