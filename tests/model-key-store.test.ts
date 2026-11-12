import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelKeyStore } from "../src/agent/model-key-store.js";

async function tempFile(name: string): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "data-agent-model-key-"));
  return { dir, path: join(dir, name) };
}

it("keeps one key per provider and reports how it is protected", async () => {
  const { dir, path } = await tempFile("model-key.json");
  try {
    const store = new ModelKeyStore(path);
    assert.equal(store.state().status, "missing");
    assert.equal(store.state().protection, "none");
    assert.equal(store.get("openai"), undefined);

    assert.equal(store.save("openai", "sk-openai"), "file-mode-0600");
    assert.equal(store.save("my-gw", "gw-key"), "file-mode-0600");
    assert.equal(store.get("openai"), "sk-openai");
    assert.deepEqual(store.state().providers, ["my-gw", "openai"]);
    // Without DATA_AGENT_PROFILE_SECRET_KEY the store says so instead of implying encryption.
    assert.equal(store.state().protection, "file-mode-0600");

    // A second instance reads the same file: the key survives a restart.
    const reopened = new ModelKeyStore(path);
    assert.equal(reopened.get("openai"), "sk-openai");
    assert.equal(reopened.state().status, "ok");

    // Clearing one provider leaves the others alone; clearing everything removes the file.
    reopened.clear("openai");
    assert.equal(reopened.get("openai"), undefined);
    assert.equal(reopened.get("my-gw"), "gw-key");
    reopened.clear();
    assert.deepEqual(reopened.state().providers, []);
    assert.equal(existsSync(path), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("encrypts the key when DATA_AGENT_PROFILE_SECRET_KEY is set, and degrades visibly without it", async () => {
  const { dir, path } = await tempFile("model-key.json");
  try {
    const store = new ModelKeyStore(path, "profile-secret");
    assert.equal(store.save("openai", "sk-secret-value"), "aes-256-gcm");
    const raw = await readFile(path, "utf8");
    assert.equal(raw.includes("sk-secret-value"), false);

    const reopened = new ModelKeyStore(path, "profile-secret");
    assert.equal(reopened.state().protection, "aes-256-gcm");
    assert.equal(reopened.get("openai"), "sk-secret-value");

    // A different secret cannot open the ciphertext: the key is reported unusable, not misread.
    const wrong = new ModelKeyStore(path, "another-secret");
    assert.equal(wrong.get("openai"), undefined);
    assert.equal(wrong.state().status, "invalid");
    assert.deepEqual(wrong.state().providers, []);

    // Starting without the secret cannot decrypt either, and never falls back to the raw file.
    const noSecret = new ModelKeyStore(path);
    assert.equal(noSecret.get("openai"), undefined);
    assert.equal(noSecret.state().status, "invalid");

    // A corrupt file is tolerated: the service starts with no console key instead of crashing.
    const broken = await tempFile("broken.json");
    try {
      await (await import("node:fs/promises")).writeFile(broken.path, "{not json", "utf8");
      const store2 = new ModelKeyStore(broken.path, "profile-secret");
      assert.equal(store2.state().status, "invalid");
      assert.deepEqual(store2.state().providers, []);
    } finally {
      await rm(broken.dir, { recursive: true, force: true });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
