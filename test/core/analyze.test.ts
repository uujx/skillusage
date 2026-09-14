import assert from "node:assert/strict";
import test from "node:test";

import { analyzeSkillUsage } from "../../src/core/analyze.js";
import { assertReportShape, reportJsonSchema } from "../../src/core/report-schema.js";

test("aggregates same Skill across sessions and preserves latest detection", () => {
  const report = analyzeSkillUsage(
    {
      range: {
        kind: "bounded",
        from: "2026-08-01T00:00:00.000Z",
        untilExclusive: "2026-09-01T00:00:00.000Z",
      },
      timezone: "Asia/Shanghai",
      codexHome: "/private/codex",
      jobs: 1,
    },
    {
      platform: "codex",
      sessions: [
        {
          sessionKey: "s-1",
          loads: [
            {
              skill: { id: "a", name: "brainstorming" },
              turnKey: "t-1",
              occurredAt: "2026-08-02T00:00:00.000Z",
            },
          ],
          requests: [],
          unreadableRecords: 0,
          unresolvedLoadCandidates: 0,
          unresolvedRequestCandidates: 0,
        },
        {
          sessionKey: "s-2",
          loads: [
            {
              skill: { id: "a", name: "brainstorming" },
              turnKey: "t-2",
              occurredAt: "2026-08-03T00:00:00.000Z",
            },
          ],
          requests: [],
          unreadableRecords: 0,
          unresolvedLoadCandidates: 0,
          unresolvedRequestCandidates: 0,
        },
      ],
      inventory: {
        status: "complete",
        skills: [
          { id: "a", name: "brainstorming" },
          { id: "b", name: "unused" },
        ],
        unresolvedSources: 0,
      },
      sourceStats: {
        filesScanned: 2,
        bytesScanned: 100,
        unreadableRecords: 0,
        requestUnreadableRecords: 0,
      },
    },
    "0.1.0",
  );

  assert.deepEqual(report.summary, { loads: 2, sessions_with_loads: 2, requests: 0, sessions_with_requests: 0 });
  assert.deepEqual(report.skills, [
    {
      id: "a",
      name: "brainstorming",
      loads: 2,
      sessions: 2,
      last_detected_at: "2026-08-03T00:00:00.000Z",
      daily_loads: [
        { date: "2026-08-02", count: 1 },
        { date: "2026-08-03", count: 1 },
      ],
    },
  ]);
  assert.deepEqual(report.zero_load_skills, [
    {
      id: "b",
      name: "unused",
      detection_status: "not_detected_in_range",
    },
  ]);
});

test("sorts equal Loads by Sessions, latest detection, then name", () => {
  const report = analyzeSkillUsage(
    {
      range: { kind: "bounded", from: "2026-08-01T00:00:00.000Z", untilExclusive: "2026-09-01T00:00:00.000Z" },
      timezone: "UTC", codexHome: "/private/codex", jobs: 1,
    },
    {
      platform: "codex",
      sessions: [
        {
          sessionKey: "s-1",
          loads: [
            { skill: { id: "a", name: "alpha" }, turnKey: "a-1", occurredAt: "2026-08-02T00:00:00.000Z" },
            { skill: { id: "b", name: "beta" }, turnKey: "b-1", occurredAt: "2026-08-03T00:00:00.000Z" },
            { skill: { id: "c", name: "charlie" }, turnKey: "c-1", occurredAt: "2026-08-04T00:00:00.000Z" },
            { skill: { id: "d", name: "delta" }, turnKey: "d-1", occurredAt: "2026-08-04T00:00:00.000Z" },
          ],
          requests: [],
          unreadableRecords: 0, unresolvedLoadCandidates: 0,
          unresolvedRequestCandidates: 0,
        },
        {
          sessionKey: "s-2",
          loads: [
            { skill: { id: "a", name: "alpha" }, turnKey: "a-2", occurredAt: "2026-08-02T00:00:00.000Z" },
            { skill: { id: "b", name: "beta" }, turnKey: "b-2", occurredAt: "2026-08-05T00:00:00.000Z" },
          ],
          requests: [],
          unreadableRecords: 0, unresolvedLoadCandidates: 0,
          unresolvedRequestCandidates: 0,
        },
      ],
      inventory: { status: "complete", skills: [], unresolvedSources: 0 },
      sourceStats: { filesScanned: 2, bytesScanned: 1, unreadableRecords: 0, requestUnreadableRecords: 0 },
    },
    "0.1.0",
  );

  assert.deepEqual(report.skills.map((skill) => skill.name), ["beta", "alpha", "charlie", "delta"]);
});

test("keeps Requested separate and creates dense local daily activity", () => {
  const report = analyzeSkillUsage({
    range: { kind: "bounded", from: "2026-08-01T00:00:00.000Z", untilExclusive: "2026-08-04T00:00:00.000Z" },
    timezone: "UTC", codexHome: "/private/codex", jobs: 1,
  }, {
    platform: "codex",
    sessions: [{
      sessionKey: "s", loads: [{ skill: { id: "loaded", name: "loaded" }, turnKey: "l", occurredAt: "2026-08-02T00:00:00.000Z" }],
      requests: [
        { skill: { id: "requested", name: "requested" }, turnKey: "r-1", occurredAt: "2026-08-01T00:00:00.000Z" },
        { skill: { id: "requested", name: "requested" }, turnKey: "r-2", occurredAt: "2026-08-03T00:00:00.000Z" },
      ],
      unreadableRecords: 0, unresolvedLoadCandidates: 0, unresolvedRequestCandidates: 0,
    }],
    inventory: { status: "complete", skills: [], unresolvedSources: 0 },
    sourceStats: { filesScanned: 1, bytesScanned: 1, unreadableRecords: 0, requestUnreadableRecords: 0 },
  }, "1.0.0");
  assert.deepEqual(report.summary, { loads: 1, sessions_with_loads: 1, requests: 2, sessions_with_requests: 1 });
  assert.deepEqual(report.activity, [
    { date: "2026-08-01", loads: 0, requests: 1 },
    { date: "2026-08-02", loads: 1, requests: 0 },
    { date: "2026-08-03", loads: 0, requests: 1 },
  ]);
  assert.equal(report.requested_skills[0]?.name, "requested");
  assert.equal(report.skills[0]?.name, "loaded");
});

test("rejects report missing required V1 coverage fields", () => {
  assert.throws(
    () => assertReportShape({ schema_version: "1.0.0", tool_version: "0.1.0", skills: [], zero_load_skills: [] }),
    /invalid report schema/,
  );
  assert.throws(
    () => assertReportShape({
      schema_version: "1.1.0", tool_version: "1.0.0", query: {},
      coverage: {
        history_complete: true, request_history_complete: true, inventory_status: "complete",
        files_scanned: 0, bytes_scanned: 0, sessions_scanned: 0, unreadable_records: 0,
        unresolved_load_candidates: 0, unresolved_request_candidates: 0, unresolved_inventory_sources: 0,
      },
      summary: { loads: 0, sessions_with_loads: 0 }, activity: [], skills: [], requested_skills: [], zero_load_skills: [],
    }),
    /invalid report schema/,
  );
  assert.equal(reportJsonSchema.properties.coverage.type, "object");
});
