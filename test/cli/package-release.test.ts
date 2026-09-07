import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("npm publish requires no package auto-correction", () => {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(npm, ["publish", "--dry-run", "--access", "public"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0, output);
  assert.doesNotMatch(output, /auto-corrected/i);
});
