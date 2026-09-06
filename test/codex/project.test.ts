import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { mkdtemp } from "node:fs/promises";
import test from "node:test";

import { projectFromCwd } from "../../src/codex/project.js";

const exec = promisify(execFile);

test("uses Git repository root for readable project identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "skillusage-project-"));
  await exec("git", ["init", "-q", root]);
  const nested = join(root, "src", "nested");
  await mkdir(nested, { recursive: true });

  const project = await projectFromCwd(nested);

  assert.equal(project.ref.name, basename(root));
  assert.match(project.ref.id, /^[a-f0-9]{64}$/);
  assert.equal(project.root, root);
});
