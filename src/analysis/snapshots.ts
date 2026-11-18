import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { AppError } from "../errors.js";

export interface Snapshot {
  id: string;
  name: string;
  result_id: string;
  created_at: string;
  session_id: string;
}
/** Snapshots pin an existing immutable, bounded local result; never trigger source extraction. */
export class SnapshotStore {
  private static locks = new Map<string, Promise<unknown>>();
  private serial<T>(session: string, run: () => Promise<T>): Promise<T> {
    const key = this.path(session),
      tail = SnapshotStore.locks.get(key) ?? Promise.resolve();
    const next = tail.then(run, run),
      settled = next.then(
        () => undefined,
        () => undefined,
      );
    SnapshotStore.locks.set(key, settled);
    void settled.then(() => {
      if (SnapshotStore.locks.get(key) === settled) SnapshotStore.locks.delete(key);
    });
    return next;
  }
  constructor(private readonly root: string) {}
  private path(session: string) {
    if (!/^[a-zA-Z0-9_-]+$/.test(session)) throw new AppError("INVALID_INPUT", "Invalid session");
    return join(this.root, session + ".json");
  }
  async list(session: string): Promise<Snapshot[]> {
    try {
      return JSON.parse(await readFile(this.path(session), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }
  private async save(session: string, list: Snapshot[]) {
    await mkdir(this.root, { recursive: true });
    const p = this.path(session),
      temp = p + "." + randomUUID() + ".tmp";
    await writeFile(temp, JSON.stringify(list), { mode: 0o600 });
    await rename(temp, p);
  }
  async create(session: string, result: string, name: string) {
    return this.serial(session, async () => {
      if (!name.trim() || name.length > 120)
        throw new AppError("INVALID_INPUT", "Snapshot name must be 1–120 characters");
      const list = await this.list(session);
      if (list.length >= 20) throw new AppError("DATASET_LIMIT_REACHED", "At most 20 local snapshots per session");
      const snapshot = {
        id: "snp_" + randomUUID().replace(/-/g, "").slice(0, 20),
        name,
        result_id: result,
        created_at: new Date().toISOString(),
        session_id: session,
      };
      await this.save(session, [...list, snapshot]);
      return snapshot;
    });
  }
  async drop(session: string, id: string) {
    return this.serial(session, async () => {
      const list = await this.list(session);
      if (!list.some((s) => s.id === id)) throw new AppError("NOT_FOUND", "Snapshot not found");
      await this.save(
        session,
        list.filter((s) => s.id !== id),
      );
    });
  }
}
