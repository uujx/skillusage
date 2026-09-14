import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("npm publish requires no package auto-correction", () => {
  const isWindows = process.platform === "win32";
  const command = isWindows ? process.env.ComSpec ?? "cmd.exe" : "npm";
  const args = isWindows
    ? ["/d", "/s", "/c", "npm publish --dry-run --access public"]
    : ["publish", "--dry-run", "--access", "public"];
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, npm_config_cache: join(tmpdir(), "skillusage-npm-cache") },
  });
  const output = `${result.stdout}${result.stderr}`;

  assert.ifError(result.error);
  assert.equal(result.status, 0, output);
  assert.doesNotMatch(output, /auto-corrected/i);
  assert.match(output, /RELEASE_NOTES\.md/);
});
