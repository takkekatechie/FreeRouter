import type { ChatRequest, ChatResponse, StreamChunk, TokenUsage } from '../types.js'
import { BaseProvider, type ProviderPricing } from './base-provider.js'

const API_BASE = 'https://api.anthropic.com/v1'
const ANTHROPIC_VERSION = '2023-06-01'

const PRICING: Record<string, ProviderPricing> = {
  'claude-opus-4':       { input: 15.00, output: 75.00 },
  'claude-sonnet-4':     { input: 3.00,  output: 15.00 },
  'claude-3-7-sonnet':   { input: 3.00,  output: 15.00 },
  'claude-3-5-sonnet':   { input: 3.00,  output: 15.00 },
  'claude-3-5-haiku':    { input: 0.80,  output: 4.00  },
  'claude-3-haiku':      { input: 0.25,  output: 1.25  },
  'claude-3-opus':       { input: 15.00, output: 75.00 },
}

const DEFAULT_PRICING: ProviderPricing = { input: 3.00, output: 15.00 }

interface AnthropicResponse {
  id: string
  content: Array<{ type: string; text: string }>
  usage: { input_tokens: number; output_tokens: number }
}

interface AnthropicStreamEvent {
  type: string
  delta?: { type: string; text?: string }
  usage?: { input_tokens: number; output_tokens: number }
  message?: { usage: { input_tokens: number; output_tokens: number } }
}

export class AnthropicProvider extends BaseProvider {
  readonly name = 'anthropic'

  pricing(model: string): ProviderPricing {
    const key = Object.keys(PRICING).find(k => model.startsWith(k))
    return key !== undefined ? (PRICING[key] ?? DEFAULT_PRICING) : DEFAULT_PRICING
  }

  private buildRequestBody(req: ChatRequest, stream: boolean) {
    const systemMsg = req.messages.find(m => m.role === 'system')
    const messages = req.messages
      .filter(m => m.role !== 'system')
      .map(m => ({ role: m.role, content: m.content }))

    return {
      model: req.model.replace(/^anthropic\//, ''),
      messages,
      ...(systemMsg && { system: systemMsg.content }),
      max_tokens: req.maxTokens ?? 4096,
      ...(req.temperature !== undefined && { temperature: req.temperature }),
      stream,
    }
  }

  async chat(req: ChatRequest, apiKey: string): Promise<ChatResponse> {
    const start = Date.now()

    const resp = await fetch(`${API_BASE}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify(this.buildRequestBody(req, false)),
    })

    if (!resp.ok) await this.throwHttpError(resp, this.name)

    const data = (await resp.json()) as AnthropicResponse
    const text = data.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('')

    const usage: TokenUsage = {
      promptTokens: data.usage.input_tokens,
      completionTokens: data.usage.output_tokens,
      totalTokens: data.usage.input_tokens + data.usage.output_tokens,
    }

    return {
      id: data.id,
      model: req.model.replace(/^anthropic\//, ''),
      content: text,
      usage,
      latencyMs: this.elapsed(start),
      provider: this.name,
      finishedAt: Date.now(),
    }
  }

  async *chatStream(req: ChatRequest, apiKey: string): AsyncIterable<StreamChunk> {
    const resp = await fetch(`${API_BASE}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify(this.buildRequestBody(req, true)),
    })

    if (!resp.ok) await this.throwHttpError(resp, this.name)
    if (resp.body === null) throw new Error('[FreeRouter/anthropic] Empty stream body')

    const reader = resp.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let inputTokens = 0
    let outputTokens = 0

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const json = line.slice(6).trim()
        try {
          const event = JSON.parse(json) as AnthropicStreamEvent
          if (event.type === 'message_start' && event.message?.usage) {
            inputTokens = event.message.usage.input_tokens
          }
          if (event.type === 'content_block_delta' && event.delta?.text) {
            yield { delta: event.delta.text, done: false }
          }
          if (event.type === 'message_delta' && event.usage) {
            outputTokens = event.usage.output_tokens
          }
          if (event.type === 'message_stop') {
            const usage: TokenUsage = {
              promptTokens: inputTokens,
              completionTokens: outputTokens,
              totalTokens: inputTokens + outputTokens,
            }
            yield { delta: '', done: true, usage }
            return
          }
        } catch {
          // skip malformed
        }
      }
    }

    yield { delta: '', done: true }
  }
}
