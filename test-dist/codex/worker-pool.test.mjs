import assert from "node:assert/strict";
import { mkdtemp, mkdir, rename, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { clearTimeout, setTimeout } from "node:timers";
import { URL } from "node:url";
import { Worker } from "node:worker_threads";

test("one worker processes multiple files before shutdown", async () => {
  const root = await mkdtemp(join(tmpdir(), "skillusage-worker-pool-"));
  await mkdir(join(root, "sessions"), { recursive: true });
  const paths = [join(root, "sessions", "one.jsonl"), join(root, "sessions", "two.jsonl")];
  await Promise.all(paths.map((path, index) => writeFile(path, `${JSON.stringify({
    type: "session_meta",
    payload: { id: `session-${index + 1}`, cwd: root },
  })}\n`)));
  const files = await Promise.all(paths.map(async (path, ordinal) => ({
    path,
    sizeBytes: (await stat(path)).size,
    mtimeMs: (await stat(path)).mtimeMs,
    ordinal,
  })));
  const worker = new Worker(new URL("../../dist/codex/worker.js", import.meta.url), {
    workerData: {
      request: {
        range: { kind: "all", asOf: "2026-08-31T23:59:59.999Z" },
        timezone: "UTC",
        codexHome: root,
        jobs: 1,
      },
      inventory: {
        result: { status: "complete", skills: [], unresolvedSources: 0 },
        aliases: [],
        acceptedRoots: [],
      },
    },
  });

  const results = [];
  const completed = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("worker did not process both files")), 2_000);
    worker.on("message", (message) => {
      if (message.kind !== "result") return;
      results.push(message.result);
      if (results.length === 1) worker.postMessage({ kind: "scan", file: files[1] });
      if (results.length === 2) {
        clearTimeout(timer);
        resolve();
      }
    });
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (results.length < 2) reject(new Error(`worker exited early with code ${code}`));
    });
  });

  worker.postMessage({ kind: "scan", file: files[0] });
  try {
    await completed;
  } finally {
    await worker.terminate();
  }

  assert.deepEqual(results.map((result) => result.sessions[0]?.sessionKey), ["session-1", "session-2"]);
});

test("worker omits byte progress when reporting is disabled", async () => {
  const root = await mkdtemp(join(tmpdir(), "skillusage-worker-progress-"));
  await mkdir(join(root, "sessions"), { recursive: true });
  const path = join(root, "sessions", "large.jsonl");
  await writeFile(path, `${"x".repeat(5 * 1024 * 1024)}\n`);
  const info = await stat(path);
  const worker = new Worker(new URL("../../dist/codex/worker.js", import.meta.url), {
    workerData: {
      reportProgress: false,
      request: {
        range: { kind: "all", asOf: "2026-08-31T23:59:59.999Z" },
        timezone: "UTC",
        codexHome: root,
        jobs: 1,
      },
      inventory: {
        result: { status: "complete", skills: [], unresolvedSources: 0 },
        aliases: [],
        acceptedRoots: [],
      },
    },
  });
  const kinds = [];
  const completed = new Promise((resolve, reject) => {
    worker.on("message", (message) => {
      kinds.push(message.kind);
      if (message.kind === "result") resolve();
    });
    worker.once("error", reject);
  });
  worker.postMessage({ kind: "scan", file: { path, sizeBytes: info.size, mtimeMs: info.mtimeMs, ordinal: 0 } });
  try {
    await completed;
  } finally {
    await worker.terminate();
  }
  assert.deepEqual(kinds, ["result"]);
});

test("compiled scanner fails when every worker source fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "skillusage-all-workers-fail-"));
  await mkdir(join(root, "sessions"), { recursive: true });
  await writeFile(join(root, "sessions", "session.jsonl"), `${JSON.stringify({
    type: "session_meta",
    payload: { id: "unreadable", cwd: root },
  })}\n`);
  const workerPath = new URL("../../dist/codex/worker.js", import.meta.url);
  const backupPath = new URL("../../dist/codex/worker.js.test-backup", import.meta.url);
  const { CodexSkillScanner } = await import("../../dist/codex/scan.js");
  await rename(workerPath, backupPath);
  try {
    await assert.rejects(
      new CodexSkillScanner().scan({
        range: { kind: "all", asOf: "2026-08-31T23:59:59.999Z" },
        timezone: "UTC",
        codexHome: root,
        jobs: 1,
      }),
      /all workers failed/,
    );
  } finally {
    await rename(backupPath, workerPath);
  }
});

test("worker serializes overlapping scan messages in receive order", async () => {
  const root = await mkdtemp(join(tmpdir(), "skillusage-worker-serial-"));
  await mkdir(join(root, "sessions"), { recursive: true });
  const paths = [join(root, "sessions", "large.jsonl"), join(root, "sessions", "small.jsonl")];
  await writeFile(paths[0], `${"x".repeat(8 * 1024 * 1024)}\n`);
  await writeFile(paths[1], `${JSON.stringify({ type: "session_meta", payload: { id: "small", cwd: root } })}\n`);
  const files = await Promise.all(paths.map(async (path, ordinal) => {
    const info = await stat(path);
    return { path, sizeBytes: info.size, mtimeMs: info.mtimeMs, ordinal };
  }));
  const worker = new Worker(new URL("../../dist/codex/worker.js", import.meta.url), {
    workerData: {
      reportProgress: false,
      request: {
        range: { kind: "all", asOf: "2026-08-31T23:59:59.999Z" },
        timezone: "UTC",
        codexHome: root,
        jobs: 1,
      },
      inventory: {
        result: { status: "complete", skills: [], unresolvedSources: 0 },
        aliases: [],
        acceptedRoots: [],
      },
    },
  });
  const ordinals = [];
  const completed = new Promise((resolve, reject) => {
    worker.on("message", (message) => {
      if (message.kind !== "result") return;
      ordinals.push(message.result.ordinal);
      if (ordinals.length === 2) resolve();
    });
    worker.once("error", reject);
  });
  worker.postMessage({ kind: "scan", file: files[0] });
  worker.postMessage({ kind: "scan", file: files[1] });
  try {
    await completed;
  } finally {
    await worker.terminate();
  }
  assert.deepEqual(ordinals, [0, 1]);
});
