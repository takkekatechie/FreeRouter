import { describe, it, expect, vi, beforeEach } from 'vitest'
import { FreeRouter } from '../src/router.js'
import { createMiddleware } from '../src/adapters/middleware.js'

const masterKey = Buffer.alloc(32, 'd').toString('hex')

function makeGeminiMock(content = 'middleware-response') {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      candidates: [{ content: { parts: [{ text: content }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 5, totalTokenCount: 10 },
    }),
    body: null, status: 200, statusText: 'OK',
  })
}

// Minimal mock request/response objects
function makeMockReq(body: unknown, headers: Record<string, string> = {}) {
  return { body, headers }
}

function makeMockRes() {
  const res = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: undefined as unknown,
    ended: false,
    chunks: [] as string[],
    status(code: number) { this.statusCode = code; return this },
    setHeader(name: string, value: string) { this.headers[name] = value },
    json(b: unknown) { this.body = b },
    send(b: unknown) { this.body = b },
    write(chunk: string) { this.chunks.push(chunk) },
    end() { this.ended = true },
  }
  return res
}

describe('createMiddleware', () => {
  let router: FreeRouter
  let middleware: ReturnType<typeof createMiddleware>

  beforeEach(() => {
    router = new FreeRouter({ masterKey, audit: { enabled: false } })
    router.setKey('anonymous', 'google', 'fake-key')
    vi.stubGlobal('fetch', makeGeminiMock())
    middleware = createMiddleware(router)
  })

  it('returns OpenAI-compatible JSON for non-streaming request', async () => {
    const req = makeMockReq({
      model: 'gemini-2.0-flash',
      messages: [{ role: 'user', content: 'hello' }],
    })
    const res = makeMockRes()
    await middleware(req, res)
    expect(res.statusCode).toBe(200)
    const body = res.body as Record<string, unknown>
    expect(body['object']).toBe('chat.completion')
    expect(Array.isArray(body['choices'])).toBe(true)
    const choices = body['choices'] as Array<Record<string, unknown>>
    expect(choices[0]?.['message']).toMatchObject({ role: 'assistant', content: 'middleware-response' })
    expect(body['usage']).toMatchObject({ prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 })
  })

  it('returns 400 for missing model field', async () => {
    const req = makeMockReq({ messages: [{ role: 'user', content: 'hi' }] })
    const res = makeMockRes()
    await middleware(req, res)
    expect(res.statusCode).toBe(400)
    const body = res.body as Record<string, unknown>
    expect(body['error']).toBeDefined()
  })

  it('returns 400 for missing messages array', async () => {
    const req = makeMockReq({ model: 'gemini-2.0-flash' })
    const res = makeMockRes()
    await middleware(req, res)
    expect(res.statusCode).toBe(400)
  })

  it('returns 400 for non-object body', async () => {
    const req = makeMockReq('not-an-object')
    const res = makeMockRes()
    await middleware(req, res)
    expect(res.statusCode).toBe(400)
  })

  it('uses extractUserId option', async () => {
    const customMiddleware = createMiddleware(router, {
      extractUserId: () => 'custom-user',
    })
    // Register key for custom-user
    router.setKey('custom-user', 'google', 'fake-key')
    const req = makeMockReq({
      model: 'gemini-2.0-flash',
      messages: [{ role: 'user', content: 'hi' }],
    })
    const res = makeMockRes()
    await customMiddleware(req, res)
    expect(res.statusCode).toBe(200)
  })

  it('sends SSE frames for streaming requests', async () => {
    // Build a streaming mock
    const encoder = new TextEncoder()
    const sseLines = [
      'data: {"candidates":[{"content":{"parts":[{"text":"chunk1"}]}}]}\n\n',
      'data: {"candidates":[{"content":{"parts":[{"text":"chunk2"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":5,"totalTokenCount":10}}\n\n',
    ]
    let lineIdx = 0
    const mockStream = {
      getReader: () => ({
        async read() {
          if (lineIdx < sseLines.length) {
            const value = encoder.encode(sseLines[lineIdx++])
            return { done: false as const, value }
          }
          return { done: true as const, value: undefined }
        },
        releaseLock: vi.fn(),
      }),
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200, statusText: 'OK',
      body: mockStream,
    }))

    const req = makeMockReq({
      model: 'gemini-2.0-flash',
      messages: [{ role: 'user', content: 'stream me' }],
      stream: true,
    })
    const res = makeMockRes()
    await middleware(req, res)

    expect(res.headers['content-type']).toContain('text/event-stream')
    expect(res.ended).toBe(true)
    expect(res.chunks.some(c => c.includes('[DONE]'))).toBe(true)
  })
})
