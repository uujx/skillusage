import assert from "node:assert/strict";
import test from "node:test";

import { renderTerminal } from "../../src/render/terminal.js";

const coverage = {
  history_complete: false,
  inventory_status: "complete" as const,
  files_scanned: 12,
  bytes_scanned: 34,
  sessions_scanned: 5,
  unreadable_records: 1,
  unresolved_load_candidates: 2,
  unresolved_inventory_sources: 0,
};

test("renders two-section report with concrete dates and no default diagnostics", () => {
  const output = renderTerminal({
    schema_version: "1.0.0", tool_version: "0.1.0",
    query: { platform: "codex", range: { kind: "bounded", from: "2026-08-01", until: "2026-08-31" }, timezone: "Asia/Shanghai" },
    coverage,
    summary: { loads: 3, sessions_with_loads: 2 },
    skills: [
      { id: "a", name: "alpha", loads: 2, sessions: 2, last_detected_at: "2026-08-31T18:00:00.000Z" },
      { id: "b", name: "beta", loads: 1, sessions: 1, last_detected_at: "2026-08-30T18:00:00.000Z" },
    ],
    zero_load_skills: [{ id: "z", name: "zeta", detection_status: "not_detected_in_range" }],
  }, { isTTY: false });

  assert.match(output, /Skill usage · codex/);
  assert.match(output, /2026-08-01 – 2026-08-31 · All projects/);
  assert.match(output, /3 loads · 2 sessions · 2 \/ 3 skills loaded/);
  assert.match(output, /Loaded skills · 2/);
  assert.match(output, /alpha\s+2\s+2\s+2026-09-01/);
  assert.match(output, /Not loaded in this range · 1\nzeta/);
  assert.doesNotMatch(output, /Coverage|Inventory|unreadable|unresolved|files_scanned|bytes_scanned/);
});

test("uses compact zero-skill columns only in TTY", () => {
  const report = {
    schema_version: "1.0.0" as const, tool_version: "0.1.0",
    query: { platform: "codex", range: { kind: "bounded" as const, from: "2026-08-01", until: "2026-08-31" }, timezone: "UTC" },
    coverage,
    summary: { loads: 1, sessions_with_loads: 1 },
    skills: [{ id: "a", name: "alpha", loads: 1, sessions: 1, last_detected_at: "2026-08-31T00:00:00.000Z" }],
    zero_load_skills: [
      { id: "b", name: "beta", detection_status: "not_detected_in_range" as const },
      { id: "c", name: "charlie", detection_status: "not_detected_in_range" as const },
      { id: "d", name: "delta", detection_status: "not_detected_in_range" as const },
    ],
  };
  const tty = renderTerminal(report, { isTTY: true, columns: 80 });
  const pipe = renderTerminal(report, { isTTY: false });
  assert.match(tty, /beta\s{2,}charlie/);
  assert.match(pipe, /beta\ncharlie\ndelta/);
});

test("uses available TTY width before truncating loaded Skill names", () => {
  const output = renderTerminal({
    schema_version: "1.0.0", tool_version: "0.1.0",
    query: { platform: "codex", range: { kind: "bounded", from: "2026-08-01", until: "2026-08-31" }, timezone: "UTC" },
    coverage,
    summary: { loads: 1, sessions_with_loads: 1 },
    skills: [
      { id: "a", name: "verification-before-completion", loads: 1, sessions: 1, last_detected_at: "2026-08-31T00:00:00.000Z" },
      { id: "b", name: "tiny", loads: 1, sessions: 1, last_detected_at: "2026-08-31T00:00:00.000Z" },
    ],
    zero_load_skills: [],
  }, { isTTY: true, columns: 120 });
  assert.match(output, /verification-before-completion/);
  assert.doesNotMatch(output, /verificatio…/);
});

test("keeps loaded fields readable in narrow TTY", () => {
  const output = renderTerminal({
    schema_version: "1.0.0", tool_version: "0.1.0",
    query: { platform: "codex", range: { kind: "bounded", from: "2026-08-01", until: "2026-08-31" }, timezone: "UTC" },
    coverage,
    summary: { loads: 114, sessions_with_loads: 72 },
    skills: [{ id: "a", name: "verification-before-completion", loads: 114, sessions: 72, last_detected_at: "2026-08-31T00:00:00.000Z" }],
    zero_load_skills: [],
  }, { isTTY: true, columns: 40 });
  assert.match(output, /verification-before-completion/);
  assert.match(output, /114 loads · 72 sessions · 2026-08-31/);
  assert.ok(output.split("\n").every((line) => line.length <= 40));
});

test("keeps zero section available when no Loads exist and hides it when inventory is unavailable", () => {
  const base = {
    schema_version: "1.0.0" as const, tool_version: "0.1.0",
    query: { platform: "codex", range: { kind: "bounded" as const, from: "2026-08-01", until: "2026-08-31" }, timezone: "UTC" },
    coverage,
    summary: { loads: 0, sessions_with_loads: 0 },
    skills: [],
    zero_load_skills: [{ id: "z", name: "zeta", detection_status: "not_detected_in_range" as const }],
  };
  assert.match(renderTerminal(base, { isTTY: false }), /No Skill Load detected in selected range[\s\S]*zeta/);
  const unavailable = renderTerminal({ ...base, coverage: { ...coverage, inventory_status: "unavailable" as const }, zero_load_skills: [] }, { isTTY: false });
  assert.match(unavailable, /Current Skill inventory unavailable/);
  assert.doesNotMatch(unavailable, /Not loaded in this range/);
});

test("separates detected Top-down Skills from current zero-load Skills", () => {
  const output = renderTerminal({
    schema_version: "1.0.0", tool_version: "0.1.0",
    query: { platform: "codex", range: { kind: "all", as_of: "2026-08-31T00:00:00.000Z" }, timezone: "UTC" },
    coverage: { history_complete: true, inventory_status: "complete", files_scanned: 1, bytes_scanned: 2, sessions_scanned: 1, unreadable_records: 0, unresolved_load_candidates: 0, unresolved_inventory_sources: 0 },
    summary: { loads: 2, sessions_with_loads: 1 },
    skills: [{ id: "a", name: "brainstorming", loads: 2, sessions: 1, last_detected_at: "2026-08-31T00:00:00.000Z" }],
    zero_load_skills: [{ id: "b", name: "review", detection_status: "never_detected" }],
  });
  assert.match(output, /Loaded skills · 1[\s\S]*brainstorming/);
  assert.match(output, /Not loaded in this range · 1[\s\S]*review/);
});

test("fails closed when terminal Skill name carries an absolute user path", () => {
  assert.throws(() => renderTerminal({
    schema_version: "1.0.0", tool_version: "0.1.0",
    query: { platform: "codex", range: { kind: "all", as_of: "2026-08-31T00:00:00.000Z" }, timezone: "UTC" },
    coverage: { history_complete: true, inventory_status: "complete", files_scanned: 0, bytes_scanned: 0, sessions_scanned: 0, unreadable_records: 0, unresolved_load_candidates: 0, unresolved_inventory_sources: 0 },
    summary: { loads: 1, sessions_with_loads: 1 },
    skills: [{ id: "a", name: "/home/test/private", loads: 1, sessions: 1, last_detected_at: "2026-08-31T00:00:00.000Z" }],
    zero_load_skills: [],
  }), /unsafe report output/);
});

test("shows range, project, and short IDs for duplicate Skill names", () => {
  const output = renderTerminal({
    schema_version: "1.0.0", tool_version: "0.1.0",
    query: { platform: "codex", range: { kind: "bounded", from: "2026-08-01", until: "2026-08-31" }, timezone: "Asia/Shanghai", project: { id: "12345678abcdef", name: "demo" } },
    coverage: { history_complete: true, inventory_status: "complete", files_scanned: 1, bytes_scanned: 1, sessions_scanned: 1, unreadable_records: 0, unresolved_load_candidates: 0, unresolved_inventory_sources: 0 },
    summary: { loads: 1, sessions_with_loads: 1 },
    skills: [{ id: "aaaaaaaa1111", name: "review", loads: 1, sessions: 1, last_detected_at: "2026-08-31T00:00:00.000Z" }],
    zero_load_skills: [{ id: "bbbbbbbb2222", name: "review", detection_status: "not_detected_in_range" }],
  });
  assert.match(output, /2026-08-01 – 2026-08-31 · Project demo/);
  assert.match(output, /review \[aaaaaaaa\]/);
  assert.match(output, /review \[bbbbbbbb\]/);
});

test("fails closed for private absolute path", () => {
  assert.throws(() => renderTerminal({
    schema_version: "1.0.0", tool_version: "0.1.0",
    query: { platform: "codex", range: { kind: "all", as_of: "2026-08-31T00:00:00.000Z" }, timezone: "UTC" },
    coverage: { history_complete: true, inventory_status: "complete", files_scanned: 0, bytes_scanned: 0, sessions_scanned: 0, unreadable_records: 0, unresolved_load_candidates: 0, unresolved_inventory_sources: 0 },
    summary: { loads: 1, sessions_with_loads: 1 },
    skills: [{ id: "a", name: "/private/tmp/secret", loads: 1, sessions: 1, last_detected_at: "2026-08-31T00:00:00.000Z" }],
    zero_load_skills: [],
  }), /unsafe report output/);
});
