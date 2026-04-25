import type { ChatRequest, ChatResponse, StreamChunk, TokenUsage } from '../types.js'
import { BaseProvider, type ProviderPricing } from './base-provider.js'

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta'

/** Gemini model pricing (USD per 1M tokens) as of 2025 */
const PRICING: Record<string, ProviderPricing> = {
  'gemini-2.5-pro':        { input: 1.25,  output: 10.00 },
  'gemini-2.5-flash':      { input: 0.075, output: 0.30  },
  'gemini-2.0-flash':      { input: 0.10,  output: 0.40  },
  'gemini-2.0-flash-lite': { input: 0.075, output: 0.30  },
  'gemini-1.5-pro':        { input: 1.25,  output: 5.00  },
  'gemini-1.5-flash':      { input: 0.075, output: 0.30  },
}

const DEFAULT_PRICING: ProviderPricing = { input: 1.25, output: 5.00 }

interface GeminiContent {
  role: 'user' | 'model'
  parts: Array<{ text: string }>
}

interface GeminiResponse {
  candidates: Array<{
    content: { parts: Array<{ text: string }> }
    finishReason: string
  }>
  usageMetadata: {
    promptTokenCount: number
    candidatesTokenCount: number
    totalTokenCount: number
  }
}

export class GoogleProvider extends BaseProvider {
  readonly name = 'google'

  pricing(model: string): ProviderPricing {
    // Match on the base model name, ignoring suffixes like "-preview"
    const key = Object.keys(PRICING).find(k => model.startsWith(k))
    return key !== undefined ? (PRICING[key] ?? DEFAULT_PRICING) : DEFAULT_PRICING
  }

  private buildBody(req: ChatRequest): { systemInstruction?: { parts: Array<{ text: string }> }; contents: GeminiContent[] } {
    const systemMsg = req.messages.find(m => m.role === 'system')
    const contents: GeminiContent[] = req.messages
      .filter(m => m.role !== 'system')
      .map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      }))

    return systemMsg
      ? { systemInstruction: { parts: [{ text: systemMsg.content }] }, contents }
      : { contents }
  }

  async chat(req: ChatRequest, apiKey: string): Promise<ChatResponse> {
    const start = Date.now()
    const model = req.model.replace(/^google\//, '')
    const url = `${API_BASE}/models/${model}:generateContent?key=${apiKey}`

    const body = {
      ...this.buildBody(req),
      generationConfig: {
        ...(req.temperature !== undefined && { temperature: req.temperature }),
        ...(req.maxTokens !== undefined && { maxOutputTokens: req.maxTokens }),
      },
    }

    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    if (!resp.ok) await this.throwHttpError(resp, this.name)

    const data = (await resp.json()) as GeminiResponse
    const candidate = data.candidates[0]
    if (candidate === undefined) {
      throw new Error('[FreeRouter/google] No candidates returned')
    }

    const content = candidate.content.parts.map(p => p.text).join('')
    const usage: TokenUsage = {
      promptTokens: data.usageMetadata.promptTokenCount,
      completionTokens: data.usageMetadata.candidatesTokenCount,
      totalTokens: data.usageMetadata.totalTokenCount,
    }

    return {
      id: this.generateId(),
      model,
      content,
      usage,
      latencyMs: this.elapsed(start),
      provider: this.name,
      finishedAt: Date.now(),
    }
  }

  async *chatStream(req: ChatRequest, apiKey: string): AsyncIterable<StreamChunk> {
    const model = req.model.replace(/^google\//, '')
    const url = `${API_BASE}/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`

    const body = {
      ...this.buildBody(req),
      generationConfig: {
        ...(req.temperature !== undefined && { temperature: req.temperature }),
        ...(req.maxTokens !== undefined && { maxOutputTokens: req.maxTokens }),
      },
    }

    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    if (!resp.ok) await this.throwHttpError(resp, this.name)
    if (resp.body === null) throw new Error('[FreeRouter/google] Empty stream body')

    const reader = resp.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let finalUsage: TokenUsage | undefined

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const json = line.slice(6).trim()
        if (json === '[DONE]') continue
        try {
          const parsed = JSON.parse(json) as GeminiResponse
          const candidate = parsed.candidates[0]
          if (candidate === undefined) continue
          const delta = candidate.content.parts.map(p => p.text).join('')

          if (parsed.usageMetadata) {
            finalUsage = {
              promptTokens: parsed.usageMetadata.promptTokenCount,
              completionTokens: parsed.usageMetadata.candidatesTokenCount,
              totalTokens: parsed.usageMetadata.totalTokenCount,
            }
          }

          const isDone = candidate.finishReason !== 'STOP' ? false : true
          yield { delta, done: isDone, ...(isDone && finalUsage ? { usage: finalUsage } : {}) }
        } catch {
          // malformed chunk — skip
        }
      }
    }

    // Ensure a done:true chunk is always emitted
    yield { delta: '', done: true, ...(finalUsage ? { usage: finalUsage } : {}) }
  }
}
