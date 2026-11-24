import { AppError } from "../errors.js";
import { sourceConnectionLost } from "../db/source-errors.js";

/** A fixed number of serial lanes, each with its own independently proven connection. */
export class MetadataPool<T extends { close(): Promise<void>; unavailableReason?: string }> {
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
  run<R>(operation: (worker: T) => Promise<R>, before = () => {}): Promise<R> {
    if (this.closed) return Promise.reject(new Error("Metadata pool is closed"));
    if (this.slots.reduce((n, s) => n + s.pending, 0) >= 64)
      return Promise.reject(new AppError("TASK_QUEUE_FULL", "Metadata queue is full; retry later"));
    const slot = this.slots.reduce((a, b) => (a.pending <= b.pending ? a : b));
    slot.pending++;
    const next = slot.tail.then(async () => {
      if (this.closed) throw new Error("Metadata pool is closed");
      // Only read-only metadata operations use these lanes. Retry a disconnect once with
      // a fresh worker (the factory re-verifies read-only access); never cycle source SQL.
      for (let attempt = 0; ; attempt++) {
        before();
        const worker = slot.worker ??= await this.create();
        before();
        try {
          if (worker.unavailableReason) throw new AppError("SESSION_UNAVAILABLE", worker.unavailableReason);
          const value = await operation(worker);
          if (worker.unavailableReason) throw new AppError("SESSION_UNAVAILABLE", worker.unavailableReason);
          return value;
        } catch (error) {
          if (!worker.unavailableReason && !sourceConnectionLost(error)) throw error;
          slot.worker = undefined;
          await worker.close().catch(() => undefined);
          if (attempt >= 1 || this.closed) throw new AppError("CONNECTION_FAILED", "Metadata connection unavailable after reconnect; catalog coverage is incomplete", { coverage: "incomplete" });
        }
      }
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
