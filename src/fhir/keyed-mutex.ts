/**
 * Runs async tasks one at a time per key, in arrival order.
 *
 * ADT writes are check-then-write (is the bed free? is there an active stay?
 * what is the next visit number?). Without serialisation two requests can both
 * pass the check. This closes that window inside one API process; across
 * processes the `If-Match` guards on the transaction are what hold the line.
 */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.then(task);
    // The tail never rejects, so one failed task cannot block the next.
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    try {
      return await result;
    } finally {
      if (this.tails.get(key) === tail) {
        this.tails.delete(key);
      }
    }
  }
}
