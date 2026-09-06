import assert from "node:assert/strict";
import test from "node:test";

import { parseCliArgs } from "../../src/cli/args.js";

test("defaults to four workers for date-scoped scanning", () => {
  assert.equal(parseCliArgs([], new Date("2026-08-30T00:00:00.000Z")).request.jobs, 4);
});

test("resolves --days as inclusive local dates", () => {
  const options = parseCliArgs(
    ["--days", "7", "--timezone", "Asia/Shanghai", "--codex-home", "/tmp/codex"],
    new Date("2026-08-31T12:00:00.000Z"),
  );
  assert.deepEqual(options.request.range, {
    kind: "bounded",
    from: "2026-08-24T16:00:00.000Z",
    untilExclusive: "2026-08-31T16:00:00.000Z",
  });
  assert.equal(options.json, false);
});

test("rejects conflicting date modes before scan", () => {
  assert.throws(
    () => parseCliArgs(["--days", "7", "--all"], new Date("2026-08-31T00:00:00.000Z")),
    /mutually exclusive/,
  );
});

test("rejects impossible calendar date before scan", () => {
  assert.throws(
    () => parseCliArgs(["--from", "2026-02-31", "--until", "2026-03-01"], new Date()),
    /invalid date/,
  );
});

test("keeps local date boundaries across DST transition", () => {
  const options = parseCliArgs(
    ["--from", "2026-03-08", "--until", "2026-03-08", "--timezone", "America/Los_Angeles"],
    new Date("2026-03-09T00:00:00.000Z"),
  );
  assert.equal(options.request.range.kind, "bounded");
  if (options.request.range.kind === "bounded") {
    assert.equal(options.request.range.untilExclusive, "2026-03-09T07:00:00.000Z");
    assert.equal(Date.parse(options.request.range.untilExclusive) - Date.parse(options.request.range.from), 23 * 60 * 60 * 1000);
  }
});
