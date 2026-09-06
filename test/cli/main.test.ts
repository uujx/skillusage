import assert from "node:assert/strict";
import test from "node:test";

import { runCli } from "../../src/cli/main.js";

test("prints help without scanning history", async () => {
  let stdout = "";
  let stderr = "";
  const code = await runCli(["--help"], {
    stdout: { write: (value: string) => { stdout += value; } },
    stderr: { isTTY: false, write: (value: string) => { stderr += value; } },
  });
  assert.equal(code, 0);
  assert.match(stdout, /--days/);
  assert.match(stdout, /Default: --days 30/);
  assert.equal(stderr, "");
});
