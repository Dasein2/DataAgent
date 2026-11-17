import { link, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Artifact, ChartType } from "./types.js";

/**
 * File-backed artifact store.
 *
 * Objects are immutable: a change produces a new artifact id, so a saved chart never changes under
 * a report or a dashboard that cites it. The per-session index exists because listing artifacts by
 * scanning the objects directory gets slower the more sessions a deployment has (results already
 * have that problem), and the console asks for this list on every session open.
 */

const ID_PATTERN = /^art_[a-z0-9]{8,32}$/;

export interface ArtifactIndexEntry {
  id: string;
  kind: "chart";
  type: ChartType;
  title: string;
  spec_hash: string;
  result_id: string;
  task_id: string | null;
  status: Artifact["status"];
  created_at: string;
}

interface SessionIndex {
  session_id: string;
  artifacts: ArtifactIndexEntry[];
}

export class ArtifactStore {
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(private readonly root: string) {}

  private objectPath(id: string): string {
    if (!ID_PATTERN.test(id)) throw new Error("Invalid artifact id");
    return join(this.root, "objects", `${id}.json`);
  }

  private indexPath(sessionId: string): string {
    if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) throw new Error("Invalid session id");
    return join(this.root, "index", `${sessionId}.json`);
  }

  /** One writer per session keeps the read-modify-write of the index from losing entries. */
  private serial<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(sessionId) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    const settled = next.then(() => undefined, () => undefined);
    this.locks.set(sessionId, settled);
    void settled.then(() => {
      if (this.locks.get(sessionId) === settled) this.locks.delete(sessionId);
    });
    return next;
  }

  async save(artifact: Artifact): Promise<void> {
    await this.serial(artifact.session_id, async () => {
      await mkdir(join(this.root, "objects"), { recursive: true });
      await mkdir(join(this.root, "index"), { recursive: true });
      const target = this.objectPath(artifact.id);
      this.indexPath(artifact.session_id);
      const temp = `${target}.${randomUUID()}.tmp`;
      const body = JSON.stringify(artifact);
      await writeFile(temp, body, { encoding: "utf8", mode: 0o600, flag: "wx" });
      try {
        // Publishing a completed file by hard link is atomic and cannot overwrite an existing id.
        await link(temp, target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST" || await readFile(target, "utf8") !== body) throw error;
      } finally {
        await rm(temp, { force: true });
      }
      const index = await this.readIndex(artifact.session_id);
      index.artifacts = index.artifacts.filter((entry) => entry.id !== artifact.id);
      index.artifacts.push(toEntry(artifact));
      await this.writeIndex(index);
    });
  }

  async get(id: string): Promise<Artifact | undefined> {
    if (!ID_PATTERN.test(id)) return undefined;
    try {
      const raw = await readFile(this.objectPath(id), "utf8");
      const artifact = JSON.parse(raw) as Artifact;
      return artifact.id === id ? artifact : undefined;
    } catch {
      return undefined;
    }
  }

  async listBySession(sessionId: string): Promise<ArtifactIndexEntry[]> {
    return this.serial(sessionId, async () => {
      const index = await this.readIndex(sessionId);
      return [...index.artifacts].sort((a, b) => a.created_at.localeCompare(b.created_at));
    });
  }

  /** Dedupe key: the same result bound to the same spec is the same chart. */
  async findBySpec(sessionId: string, specHash: string, resultId: string): Promise<ArtifactIndexEntry | undefined> {
    const entries = await this.listBySession(sessionId);
    return entries.find(
      (entry) => entry.status === "ready" && entry.spec_hash === specHash && entry.result_id === resultId,
    );
  }

  async countByTask(sessionId: string, taskId: string | undefined): Promise<number> {
    if (!taskId) return 0;
    const entries = await this.listBySession(sessionId);
    return entries.filter((entry) => entry.task_id === taskId).length;
  }

  /** Used when a caller deletes a session on purpose; sessions otherwise leave artifacts behind. */
  async deleteSession(sessionId: string): Promise<void> {
    await this.serial(sessionId, async () => {
      const index = await this.readIndex(sessionId);
      await Promise.all(
        index.artifacts.map((entry) => rm(this.objectPath(entry.id), { force: true })),
      );
      await rm(this.indexPath(sessionId), { force: true });
    });
  }

  /** Rebuild the index by scanning objects; only used when the index file is missing or corrupt. */
  async rebuildIndex(sessionId: string): Promise<ArtifactIndexEntry[]> {
    return this.serial(sessionId, () => this.scanIndex(sessionId));
  }

  private async scanIndex(sessionId: string): Promise<ArtifactIndexEntry[]> {
    const directory = join(this.root, "objects");
    let names: string[] = [];
    try {
      names = await readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const entries: ArtifactIndexEntry[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const artifact = await this.get(name.slice(0, -5));
      if (artifact && artifact.session_id === sessionId) entries.push(toEntry(artifact));
    }
    entries.sort((a, b) => a.created_at.localeCompare(b.created_at));
    await this.writeIndex({ session_id: sessionId, artifacts: entries });
    return entries;
  }

  private async readIndex(sessionId: string): Promise<SessionIndex> {
    try {
      const parsed = JSON.parse(await readFile(this.indexPath(sessionId), "utf8")) as SessionIndex;
      if (parsed.session_id !== sessionId || !Array.isArray(parsed.artifacts)) throw new SyntaxError("corrupt index");
      return { session_id: sessionId, artifacts: parsed.artifacts };
    } catch (error) {
      if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return { session_id: sessionId, artifacts: await this.scanIndex(sessionId) };
    }
  }

  private async writeIndex(index: SessionIndex): Promise<void> {
    await mkdir(join(this.root, "index"), { recursive: true });
    const target = this.indexPath(index.session_id);
    const temp = `${target}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(index), { encoding: "utf8", mode: 0o600 });
    await rename(temp, target);
  }
}

function toEntry(artifact: Artifact): ArtifactIndexEntry {
  return {
    id: artifact.id,
    kind: artifact.kind,
    type: artifact.spec.type,
    title: artifact.spec.title ?? "",
    spec_hash: artifact.spec_hash,
    result_id: artifact.source.result_id,
    task_id: artifact.task_id ?? null,
    status: artifact.status,
    created_at: artifact.created_at,
  };
}
