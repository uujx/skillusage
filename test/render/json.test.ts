import assert from "node:assert/strict";
import test from "node:test";

import { renderJson } from "../../src/render/json.js";

test("renders deterministic newline-terminated JSON", () => {
  const value = {
    schema_version: "1.0.0",
    tool_version: "0.1.0",
    query: { platform: "codex", range: { kind: "all", as_of: "2026-08-31T00:00:00.000Z" }, timezone: "UTC" },
    coverage: { history_complete: true, inventory_status: "complete", files_scanned: 0, bytes_scanned: 0, sessions_scanned: 0, unreadable_records: 0, unresolved_load_candidates: 0, unresolved_inventory_sources: 0 },
    summary: { loads: 0, sessions_with_loads: 0 },
    skills: [],
    zero_load_skills: [],
  } as const;
  assert.equal(renderJson(value), `${JSON.stringify(value, null, 2)}\n`);
});
