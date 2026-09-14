import assert from "node:assert/strict";
import test from "node:test";

import type { SkillUsageReportV1 } from "../../src/core/types.js";
import { renderTerminal } from "../../src/render/terminal.js";

function report(skillCount = 12): SkillUsageReportV1 {
  const activity = Array.from({ length: 14 }, (_, index) => ({
    date: "2026-08-" + String(index + 1).padStart(2, "0"),
    loads: index % 3,
    requests: index % 2,
  }));
  return {
    schema_version: "1.1.0", tool_version: "1.0.0",
    query: { platform: "codex", range: { kind: "bounded", from: "2026-08-01", until: "2026-08-14" }, timezone: "UTC" },
    coverage: { history_complete: true, request_history_complete: true, inventory_status: "complete", files_scanned: 1, bytes_scanned: 2, sessions_scanned: 1, unreadable_records: 0, unresolved_load_candidates: 0, unresolved_request_candidates: 0, unresolved_inventory_sources: 0 },
    summary: { loads: skillCount, sessions_with_loads: 1, requests: 2, sessions_with_requests: 1 },
    activity,
    skills: Array.from({ length: skillCount }, (_, index) => ({
      id: "loaded-" + index, name: "loaded-" + index, loads: skillCount - index, sessions: 1,
      last_detected_at: "2026-08-14T00:00:00.000Z",
      daily_loads: activity.filter((item) => item.loads > 0).map((item) => ({ date: item.date, count: item.loads })),
    })),
    requested_skills: [{ id: "request", name: "request", requests: 2, sessions: 1, last_requested_at: "2026-08-14T00:00:00.000Z", daily_requests: activity.filter((item) => item.requests > 0).map((item) => ({ date: item.date, count: item.requests })) }],
    zero_load_skills: [{ id: "zero", name: "zero", detection_status: "not_detected_in_range" }],
  };
}

test("defaults to the complete Loaded ranking with an aligned common-width layout", () => {
  const output = renderTerminal(report(), { isTTY: true, columns: 80, now: new Date("2026-08-15T00:00:00.000Z") });
  assert.match(output, /skillusage · codex · Loaded/);
  assert.match(output, /Last 7 complete days/);
  assert.match(output, /12 {2}loaded-11/);
  assert.doesNotMatch(output, /more: skillusage/);
  assert.match(output, /Last date {3}Trend/);
  assert.match(output, /1 {2}loaded-0[^\n]+2026-08-14 {2}[▁▂▃▄▅▆▇█·]+/);
  assert.doesNotMatch(output, /\n {4}Trend [▁▂▃▄▅▆▇█·]+/);
  assert.match(output, /1 current skills: no load detected in range · --show-zero/);
  assert.match(output, /Explicit requests: skillusage --requested/);
  assert.match(output, /12 {2}loaded-11[^\n]+[▁▂▃▄▅▆▇█·]+\n\n1 current skills:/);
});

test("piped output also uses one row when the default width fits", () => {
  const output = renderTerminal(report(1), { isTTY: false });
  assert.match(output, /Last date {3}Trend/);
  assert.match(output, /1 {2}loaded-0[^\n]+2026-08-14 {2}[▁▂▃▄▅▆▇█·]+/);
});

test("Requested replaces Loaded and explicit limit truncates only the selected ranking", () => {
  const value = report();
  value.requested_skills.push({ ...value.requested_skills[0]!, id: "request-2", name: "request-2", requests: 1 });
  const output = renderTerminal(value, { requested: true, limit: 1, isTTY: false });
  assert.match(output, /skillusage · codex · Requested/);
  assert.match(output, /2 requests/);
  assert.match(output, /request/);
  assert.doesNotMatch(output, /request-2[^\n]*requests/);
  assert.match(output, /1 more: skillusage --requested --limit 0/);
  assert.doesNotMatch(output, /current skills: no load/);
  assert.doesNotMatch(output, /loaded-0/);
});

test("does not disambiguate the same logical Skill across Loaded and Requested", () => {
  const value = report(1);
  value.requested_skills[0] = {
    ...value.requested_skills[0]!, id: value.skills[0]!.id, name: value.skills[0]!.name,
  };
  const output = renderTerminal(value, { requested: true, isTTY: true, columns: 80 });
  assert.match(output, /\n1 {2}loaded-0/);
  assert.doesNotMatch(output, /loaded-0 \[/);
});

test("show-zero expands only the Loaded zero-record list", () => {
  const output = renderTerminal(report(1), { showZero: true, isTTY: false });
  assert.match(output, /Not loaded in this range · 1\nzero/);
});

test("show-zero uses width-aware columns only for TTY output", () => {
  const value = report(1);
  value.zero_load_skills = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"].map((name) => ({
    id: name, name, detection_status: "not_detected_in_range" as const,
  }));
  const tty = renderTerminal(value, { showZero: true, isTTY: true, columns: 80 });
  assert.match(tty, /Not loaded in this range · 6\nalpha {2,}charlie {2,}echo\nbravo {2,}delta {2,}foxtrot/);
  const piped = renderTerminal(value, { showZero: true, isTTY: false, columns: 80 });
  assert.match(piped, /Not loaded in this range · 6\nalpha\nbravo\ncharlie\ndelta\necho\nfoxtrot/);
});

test("all-history trend uses twelve equal-time buckets across the full range", () => {
  const value = report(1);
  value.query.range = { kind: "all", as_of: "2026-06-29T00:00:00.000Z" };
  value.activity = Array.from({ length: 180 }, (_, index) => ({
    date: new Date(Date.UTC(2026, 0, 1 + index)).toISOString().slice(0, 10),
    loads: index % 9 === 0 ? 4 : 0,
    requests: 0,
  }));
  value.skills[0]!.daily_loads = value.activity.filter((item) => item.loads > 0).map((item) => ({ date: item.date, count: item.loads }));
  const output = renderTerminal(value, { isTTY: true, columns: 80, now: new Date("2026-06-30T00:00:00.000Z") });
  assert.match(output, /Trend [▁▂▃▄▅▆▇█·]{12} · 180 days · ≈15d\/bucket/);
  assert.doesNotMatch(output, /complete months/);
});

test("narrow terminal keeps names and count details in separate lines", () => {
  const value = report(1);
  value.skills[0]!.name = "verification-before-completion";
  const output = renderTerminal(value, { isTTY: true, columns: 40 });
  assert.match(output, /verification-before-completion/);
  assert.match(output, /1 loads · 1 sessions/);
  assert.match(output, /\n {3}Trend [▁▂▃▄▅▆▇█·]+/);
});

test("wide terminal keeps every field on one row", () => {
  const value = report(1);
  value.skills[0]!.name = "verification-before-completion";
  const output = renderTerminal(value, { isTTY: true, columns: 120 });
  assert.match(output, /1 {2}verification-before-completion[^\n]+2026-08-14 {2}[▁▂▃▄▅▆▇█·]+/);
});

test("uses ASCII sparkline when requested", () => {
  const output = renderTerminal(report(1), { ascii: true, isTTY: false });
  assert.match(output, /Trend [.:\-=+*#@]+ ·/);
  assert.doesNotMatch(output, /Trend [▁▂▃▄▅▆▇█]/);
});
