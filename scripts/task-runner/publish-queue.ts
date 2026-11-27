export class PublishQueue {
  private readonly turns: Array<() => void> = [];
  private failure?: Error;

  get blocked() {
    return this.failure !== undefined;
  }

  block(reason: string) {
    this.failure = new Error(reason);
  }

  request() {
    if (this.failure) throw this.failure;
    const { promise, resolve } = Promise.withResolvers<void>();
    const waiting = this.turns.length > 0;
    this.turns.push(resolve);
    if (!waiting) resolve();

    return {
      waiting,
      enter: async (signal: AbortSignal) => {
        const wake = () => resolve();
        signal.addEventListener("abort", wake, { once: true });
        try {
          signal.throwIfAborted();
          await promise;
          signal.throwIfAborted();
          if (this.failure) throw this.failure;
        } finally {
          signal.removeEventListener("abort", wake);
        }
      },
      release: () => {
        const index = this.turns.indexOf(resolve);
        if (index === -1) return;
        this.turns.splice(index, 1);
        if (index === 0) this.turns[0]?.();
      },
    };
  }
}
