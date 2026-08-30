/**
 * Serializes `fetchMangaUpdates` calls for one source and drops duplicates that are
 * already in flight — a library refresh asks for many titles at once, and firing all of
 * them at a source simultaneously is the fastest way to get rate-limited.
 */
export class UpdateQueue {
  private readonly queue = new Set<string>();
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly rateLimitMs = 250) {}

  async add<T>(mangaSlug: string, updateFn: () => Promise<T>, emptyValue: T): Promise<T> {
    if (this.queue.has(mangaSlug)) {
      return emptyValue;
    }

    this.queue.add(mangaSlug);
    const run = this.tail.then(async () => {
      try {
        return await updateFn();
      } finally {
        this.queue.delete(mangaSlug);
        await new Promise((resolve) => setTimeout(resolve, this.rateLimitMs));
      }
    });

    this.tail = run.then(
      () => undefined,
      () => undefined,
    );

    return run;
  }

  isQueued(mangaSlug: string): boolean {
    return this.queue.has(mangaSlug);
  }
}
