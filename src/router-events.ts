/**
 * Minimal typed event emitter — zero dependencies, zero overhead.
 * on() returns an unsubscribe function for easy cleanup.
 */
export class TypedEventEmitter<TMap extends Record<string, unknown>> {
  private readonly handlers = new Map<string, Array<(payload: unknown) => void>>()

  on<K extends keyof TMap & string>(
    event: K,
    handler: (payload: TMap[K]) => void,
  ): () => void {
    let list = this.handlers.get(event)
    if (list === undefined) {
      list = []
      this.handlers.set(event, list)
    }
    list.push(handler as (payload: unknown) => void)
    return () => this.off(event, handler)
  }

  off<K extends keyof TMap & string>(
    event: K,
    handler: (payload: TMap[K]) => void,
  ): void {
    const list = this.handlers.get(event)
    if (list === undefined) return
    const idx = list.indexOf(handler as (payload: unknown) => void)
    if (idx !== -1) list.splice(idx, 1)
  }

  emit<K extends keyof TMap & string>(event: K, payload: TMap[K]): void {
    const list = this.handlers.get(event)
    if (list === undefined) return
    for (const handler of list.slice()) {
      handler(payload)
    }
  }
}
