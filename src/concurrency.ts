export class Semaphore {
  private active = 0;
  private readonly waiting = new Set<() => void>();

  constructor(private readonly limit: number) {}

  async run<T>(task: () => Promise<T>, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted();
    if (this.active < this.limit) this.active++;
    else await new Promise<void>((resolve, reject) => {
      const ready = () => { signal.removeEventListener('abort', abort); resolve(); };
      const abort = () => { this.waiting.delete(ready); reject(signal.reason); };
      this.waiting.add(ready);
      signal.addEventListener('abort', abort, { once: true });
    });
    try { signal.throwIfAborted(); return await task(); }
    finally {
      const next = this.waiting.values().next().value;
      if (next) { this.waiting.delete(next); next(); }
      else this.active--;
    }
  }
}
