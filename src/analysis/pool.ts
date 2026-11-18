import { AppError } from "../errors.js";

/** A fixed number of serial lanes, each with its own independently proven connection. */
export class MetadataPool<T extends { close(): Promise<void> }> {
  private closed = false;
  private readonly slots: Array<{
    tail: Promise<unknown>;
    worker?: T;
    pending: number;
  }>;
  constructor(
    size: number,
    private readonly create: () => Promise<T>,
  ) {
    this.slots = Array.from({ length: Math.max(1, Math.min(4, Math.floor(size))) }, () => ({
      tail: Promise.resolve(),
      pending: 0,
    }));
  }
  run<R>(operation: (worker: T) => Promise<R>): Promise<R> {
    if (this.closed) return Promise.reject(new Error("Metadata pool is closed"));
    if (this.slots.reduce((n, s) => n + s.pending, 0) >= 64)
      return Promise.reject(new AppError("TASK_QUEUE_FULL", "Metadata queue is full; retry later"));
    const slot = this.slots.reduce((a, b) => (a.pending <= b.pending ? a : b));
    slot.pending++;
    const next = slot.tail.then(async () => {
      if (this.closed) throw new Error("Metadata pool is closed");
      slot.worker ??= await this.create();
      return operation(slot.worker);
    });
    slot.tail = next
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        slot.pending--;
      });
    return next;
  }
  async close() {
    this.closed = true;
    await Promise.allSettled(
      this.slots.map(async (s) => {
        await s.tail;
        await s.worker?.close();
        s.worker = undefined;
      }),
    );
  }
}
