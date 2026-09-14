import assert from "node:assert/strict";
import test from "node:test";

import { progressLine, runCli } from "../../src/cli/main.js";

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

test("renders scan progress in the CLI's English interface language", () => {
  assert.equal(progressLine(3, 4, 3 * 1024 * 1024, 4 * 1024 * 1024, 5_000), "\rScanning 3/4 files · 3.0 MiB/4.0 MiB · 75% · 00:05");
});
