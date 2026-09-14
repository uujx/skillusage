import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";

import { CodexSkillScanner, scanFile } from "../../src/codex/scan.js";
import { resolveInventory } from "../../src/codex/inventory.js";
import { analyzeSkillUsage } from "../../src/core/analyze.js";
import { renderJson } from "../../src/render/json.js";

for (const format of ["xml", "markdown"] as const) {
  test(`recognizes removed Windows entry from ${format} session catalog`, async () => {
    const root = await mkdtemp(join(tmpdir(), "skillusage-windows-catalog-"));
    const entry = String.raw`C:\historical\removed\demo\SKILL.md`;
    const catalog = format === "xml"
      ? `<name>demo</name><path>${entry}</path>`
      : `- demo (file: ${entry})`;
    await mkdir(join(root, "sessions"), { recursive: true });
    await writeFile(join(root, "sessions", "windows.jsonl"), [
      // Keep the same resolution base on POSIX hosts, where a drive path is relative.
      { type: "session_meta", payload: { id: "windows", cwd: process.cwd(), base_instructions: { text: catalog } } },
      { type: "turn_context", payload: { turn_id: "turn-1" } },
      { timestamp: "2026-08-31T02:00:00Z", type: "response_item", payload: {
        type: "custom_tool_call", name: "exec", call_id: "windows-call",
        input: `const r = await tools.exec_command({ cmd: ${JSON.stringify(`cat "${entry}"`)} });`,
      } },
      { timestamp: "2026-08-31T02:00:01Z", type: "response_item", payload: {
        type: "custom_tool_call_output", call_id: "windows-call", output: '{"exit_code":0}',
      } },
    ].map((record) => JSON.stringify(record)).join("\n") + "\n");
    const scan = await new CodexSkillScanner().scan({
      range: { kind: "bounded", from: "2026-08-31T00:00:00Z", untilExclusive: "2026-09-01T00:00:00Z" },
      timezone: "UTC", codexHome: root, jobs: 1,
    });
    assert.deepEqual(scan.sessions[0]?.loads.map((load) => load.skill.name), ["demo"]);
    assert.equal(scan.sessions[0]?.unresolvedLoadCandidates, 0);
  });
}

test("uses injected history root without changing inventory identity", async () => {
  const inventoryRoot = await mkdtemp(join(tmpdir(), "skillusage-inventory-"));
  const historyRoot = await mkdtemp(join(tmpdir(), "skillusage-history-"));
  const skillPath = join(inventoryRoot, "skills", "benchmark", "SKILL.md");
  await mkdir(join(inventoryRoot, "skills", "benchmark"), { recursive: true });
  await mkdir(join(historyRoot, "sessions", "2026", "08", "31"), { recursive: true });
  await writeFile(skillPath, "---\nname: benchmark\ndescription: Test\n---\n");
  await writeFile(join(historyRoot, "sessions", "2026", "08", "31", "rollout.jsonl"), [
    JSON.stringify({ type: "session_meta", payload: { id: "benchmark-session", cwd: inventoryRoot } }),
    JSON.stringify({ type: "turn_context", payload: { turn_id: "benchmark-turn" } }),
    JSON.stringify({ timestamp: "2026-08-31T02:00:00.000Z", payload: { item: { type: "CommandExecution", status: "completed", exit_code: 0, command: `cat ${skillPath}` } } }),
  ].join("\n") + "\n");

  const scan = await new CodexSkillScanner({ historyHome: historyRoot }).scan({
    range: { kind: "bounded", from: "2026-08-31T00:00:00.000Z", untilExclusive: "2026-09-01T00:00:00.000Z" },
    timezone: "UTC",
    codexHome: inventoryRoot,
    jobs: 1,
  });

  assert.equal(scan.sourceStats.filesScanned, 1);
  assert.deepEqual(scan.sessions[0]?.loads.map((load) => load.skill.name), ["benchmark"]);
});

test("records only explicit user $skill requests and deduplicates history copies", async () => {
  const root = await mkdtemp(join(tmpdir(), "skillusage-requested-"));
  await mkdir(join(root, "sessions"), { recursive: true });
  await mkdir(join(root, "skills", "brainstorming"), { recursive: true });
  await writeFile(join(root, "skills", "brainstorming", "SKILL.md"), "---\nname: brainstorming\ndescription: Test\n---\n");
  await writeFile(join(root, "sessions", "rollout.jsonl"), [
    JSON.stringify({ type: "session_meta", payload: { id: "request-session", cwd: root } }),
    JSON.stringify({ timestamp: "2026-08-31T01:00:00.000Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "$brainstorming $brainstorming and $HOME, brainstorming, $missing" }] } }),
    JSON.stringify({ timestamp: "2026-08-31T01:00:01.000Z", type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "$brainstorming" }] } }),
  ].join("\n") + "\n");
  await writeFile(join(root, "history.jsonl"), JSON.stringify({ session_id: "request-session", ts: "2026-08-31T01:00:00.000Z", text: "$brainstorming $brainstorming and $HOME, brainstorming, $missing" }) + "\n");
  const scan = await new CodexSkillScanner().scan({
    range: { kind: "bounded", from: "2026-08-31T00:00:00.000Z", untilExclusive: "2026-09-01T00:00:00.000Z" },
    timezone: "UTC", codexHome: root, jobs: 1,
  });
  assert.deepEqual(scan.sessions[0]?.requests.map((item) => item.skill.name), ["brainstorming"]);
  assert.equal(scan.sessions[0]?.unresolvedRequestCandidates, 2);
});

test("deduplicates a copied Requested occurrence across Sessions but keeps a later repeat", async () => {
  const root = await mkdtemp(join(tmpdir(), "skillusage-requested-fork-"));
  await mkdir(join(root, "sessions"), { recursive: true });
  await mkdir(join(root, "skills", "caveman"), { recursive: true });
  await writeFile(join(root, "skills", "caveman", "SKILL.md"), "---\nname: caveman\ndescription: Test\n---\n");
  const userMessage = (timestamp: string) => JSON.stringify({
    timestamp,
    type: "response_item",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text: "$caveman" }] },
  });
  await writeFile(join(root, "sessions", "parent.jsonl"), [
    JSON.stringify({ type: "session_meta", payload: { id: "parent", cwd: root, source: "vscode" } }),
    userMessage("2026-08-31T01:00:00.000Z"),
    userMessage("2026-08-31T03:00:00.000Z"),
  ].join("\n") + "\n");
  await writeFile(join(root, "sessions", "fork.jsonl"), [
    JSON.stringify({ type: "session_meta", payload: { id: "fork", cwd: root, source: "vscode", forked_from_id: "parent" } }),
    userMessage("2026-08-31T01:00:00.000Z"),
  ].join("\n") + "\n");

  const scan = await new CodexSkillScanner().scan({
    range: { kind: "bounded", from: "2026-08-31T00:00:00.000Z", untilExclusive: "2026-09-01T00:00:00.000Z" },
    timezone: "UTC", codexHome: root, jobs: 1,
  });

  const report = analyzeSkillUsage({
    range: { kind: "bounded", from: "2026-08-31T00:00:00.000Z", untilExclusive: "2026-09-01T00:00:00.000Z" },
    timezone: "UTC", codexHome: root, jobs: 1,
  }, scan, "1.0.0");
  assert.equal(report.summary.requests, 2);
  assert.equal(report.requested_skills[0]?.requests, 2);
});

test("keeps Loaded stable when Requested collection is disabled", async () => {
  const root = await mkdtemp(join(tmpdir(), "skillusage-requested-toggle-"));
  const skillPath = join(root, "skills", "caveman", "SKILL.md");
  await mkdir(join(root, "sessions"), { recursive: true });
  await mkdir(join(root, "skills", "caveman"), { recursive: true });
  await writeFile(skillPath, "---\nname: caveman\ndescription: Test\n---\n");
  await writeFile(join(root, "sessions", "toggle.jsonl"), [
    JSON.stringify({ type: "session_meta", payload: { id: "toggle", cwd: root } }),
    JSON.stringify({ timestamp: "2026-08-31T01:00:00.000Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "work" }] } }),
    JSON.stringify({ timestamp: "2026-08-31T01:00:01.000Z", type: "response_item", payload: { type: "function_call", name: "exec_command", call_id: "toggle-call", arguments: JSON.stringify({ cmd: `cat ${skillPath}` }) } }),
    JSON.stringify({ timestamp: "2026-08-31T01:00:02.000Z", type: "response_item", payload: { type: "function_call_output", call_id: "toggle-call", output: "{\"exit_code\":0}" } }),
  ].join("\n") + "\n");
  const base = {
    range: { kind: "bounded" as const, from: "2026-08-31T00:00:00.000Z", untilExclusive: "2026-09-01T00:00:00.000Z" },
    timezone: "UTC", codexHome: root, jobs: 1 as const,
  };
  const without = await new CodexSkillScanner().scan({ ...base, includeRequested: false });
  const withRequests = await new CodexSkillScanner().scan({ ...base, includeRequested: true });
  assert.deepEqual(without.sessions[0]?.loads, withRequests.sessions[0]?.loads);
  assert.equal(without.sessions[0]?.loads.length, 1);
});

test("counts only the original user request across inherited and internal messages", async () => {
  const root = await mkdtemp(join(tmpdir(), "skillusage-requested-lineage-"));
  const skillPath = join(root, "skills", "caveman", "SKILL.md");
  await mkdir(join(root, "sessions"), { recursive: true });
  await mkdir(join(root, "skills", "caveman"), { recursive: true });
  await writeFile(skillPath, "---\nname: caveman\ndescription: Test\n---\n");
  const user = (timestamp: string, text: string) => JSON.stringify({
    timestamp, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] },
  });
  await writeFile(join(root, "sessions", "parent.jsonl"), [
    JSON.stringify({ type: "session_meta", payload: { id: "parent", cwd: root, source: "vscode" } }),
    user("2026-08-31T01:00:00.000Z", "$caveman"),
  ].join("\n") + "\n");
  await writeFile(join(root, "sessions", "fork.jsonl"), [
    JSON.stringify({ type: "session_meta", payload: { id: "fork", cwd: root, source: "vscode", forked_from_id: "parent" } }),
    user("2026-08-31T02:00:00.000Z", "$caveman"),
    user("2026-08-31T03:00:00.000Z", "$caveman"),
  ].join("\n") + "\n");
  await writeFile(join(root, "sessions", "child.jsonl"), [
    JSON.stringify({ type: "session_meta", payload: {
      id: "child", cwd: root, source: { subagent: { thread_spawn: { parent_thread_id: "parent", depth: 1 } } }, forked_from_id: "parent",
    } }),
    user("2026-08-31T04:00:00.000Z", "$caveman"),
    user("2026-08-31T04:00:01.000Z", '<codex_internal_context source="goal"><objective>$caveman</objective></codex_internal_context>'),
    user("2026-08-31T04:00:02.000Z", "<skill>\n<name>caveman</name>\n$ caveman\n</skill>"),
    JSON.stringify({ type: "turn_context", payload: { turn_id: "child-turn" } }),
    JSON.stringify({ timestamp: "2026-08-31T04:00:03.000Z", type: "response_item", payload: { type: "function_call", name: "exec_command", call_id: "child-load", arguments: JSON.stringify({ cmd: `cat ${skillPath}` }) } }),
    JSON.stringify({ timestamp: "2026-08-31T04:00:04.000Z", type: "response_item", payload: { type: "function_call_output", call_id: "child-load", output: "{\"exit_code\":0}" } }),
  ].join("\n") + "\n");
  const request = {
    range: { kind: "bounded" as const, from: "2026-08-31T00:00:00.000Z", untilExclusive: "2026-09-01T00:00:00.000Z" },
    timezone: "UTC", codexHome: root, jobs: 1 as const,
  };
  const report = analyzeSkillUsage(request, await new CodexSkillScanner().scan(request), "1.0.0");
  assert.equal(report.summary.requests, 2);
  assert.equal(report.requested_skills[0]?.sessions, 2);
  assert.equal(report.summary.loads, 1);
  assert.equal(report.skills[0]?.sessions, 1);
});

test("keeps independent same-time requests and marks an unavailable fork parent unresolved", async () => {
  const root = await mkdtemp(join(tmpdir(), "skillusage-requested-parent-gap-"));
  await mkdir(join(root, "sessions"), { recursive: true });
  await mkdir(join(root, "skills", "caveman"), { recursive: true });
  await writeFile(join(root, "skills", "caveman", "SKILL.md"), "---\nname: caveman\ndescription: Test\n---\n");
  const user = (id: string, timestamp: string, parent?: string) => [
    JSON.stringify({ type: "session_meta", payload: { id, cwd: root, source: "vscode", ...(parent ? { forked_from_id: parent } : {}) } }),
    JSON.stringify({ timestamp, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "$caveman" }] } }),
  ].join("\n") + "\n";
  await writeFile(join(root, "sessions", "left.jsonl"), user("left", "2026-08-31T01:00:00.000Z"));
  await writeFile(join(root, "sessions", "right.jsonl"), user("right", "2026-08-31T01:00:00.000Z"));
  await writeFile(join(root, "sessions", "orphan.jsonl"), user("orphan", "2026-08-31T02:00:00.000Z", "missing-parent"));
  const request = {
    range: { kind: "bounded" as const, from: "2026-08-31T00:00:00.000Z", untilExclusive: "2026-09-01T00:00:00.000Z" },
    timezone: "UTC", codexHome: root, jobs: 1 as const,
  };
  const report = analyzeSkillUsage(request, await new CodexSkillScanner().scan(request), "1.0.0");
  assert.equal(report.summary.requests, 2);
  assert.equal(report.coverage.unresolved_request_candidates, 1);
  assert.equal(report.coverage.request_history_complete, false);
});

test("does not recover Requested facts for a subagent from history.jsonl", async () => {
  const root = await mkdtemp(join(tmpdir(), "skillusage-requested-subagent-history-"));
  await mkdir(join(root, "sessions"), { recursive: true });
  await mkdir(join(root, "skills", "caveman"), { recursive: true });
  await writeFile(join(root, "skills", "caveman", "SKILL.md"), "---\nname: caveman\ndescription: Test\n---\n");
  await writeFile(join(root, "sessions", "child.jsonl"), JSON.stringify({ type: "session_meta", payload: {
    id: "child", cwd: root, source: { subagent: { thread_spawn: { parent_thread_id: "parent", depth: 1 } } },
  } }) + "\n");
  await writeFile(join(root, "history.jsonl"), JSON.stringify({ session_id: "child", ts: "2026-08-31T01:00:00.000Z", text: "$caveman" }) + "\n");
  const request = {
    range: { kind: "bounded" as const, from: "2026-08-31T00:00:00.000Z", untilExclusive: "2026-09-01T00:00:00.000Z" },
    timezone: "UTC", codexHome: root, jobs: 1 as const,
  };
  const report = analyzeSkillUsage(request, await new CodexSkillScanner().scan(request), "1.0.0");
  assert.equal(report.summary.requests, 0);
});

test("keeps the first session identity and makes conflicting metadata Requested-unresolved", async () => {
  const root = await mkdtemp(join(tmpdir(), "skillusage-requested-metadata-conflict-"));
  await mkdir(join(root, "sessions"), { recursive: true });
  await mkdir(join(root, "skills", "caveman"), { recursive: true });
  await writeFile(join(root, "skills", "caveman", "SKILL.md"), "---\nname: caveman\ndescription: Test\n---\n");
  const message = (timestamp: string) => JSON.stringify({
    timestamp, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "$caveman" }] },
  });
  await writeFile(join(root, "sessions", "conflict.jsonl"), [
    JSON.stringify({ type: "session_meta", payload: { id: "canonical", cwd: root, source: "vscode" } }),
    message("2026-08-31T01:00:00.000Z"),
    JSON.stringify({ type: "session_meta", payload: { id: "mirror", cwd: root, source: "vscode" } }),
    message("2026-08-31T02:00:00.000Z"),
  ].join("\n") + "\n");
  const request = {
    range: { kind: "bounded" as const, from: "2026-08-31T00:00:00.000Z", untilExclusive: "2026-09-01T00:00:00.000Z" },
    timezone: "UTC", codexHome: root, jobs: 1 as const,
  };
  const scan = await new CodexSkillScanner().scan(request);
  assert.equal(scan.sessions[0]?.sessionKey, "canonical");
  const report = analyzeSkillUsage(request, scan, "1.0.0");
  assert.equal(report.summary.requests, 0);
  assert.equal(report.coverage.unresolved_request_candidates, 2);
  assert.equal(report.coverage.request_history_complete, false);
});

test("uses an out-of-range parent only to keep an inherited request out of the child range", async () => {
  const root = await mkdtemp(join(tmpdir(), "skillusage-requested-auxiliary-parent-"));
  const parentDir = join(root, "sessions", "2026", "08", "30");
  const childDir = join(root, "sessions", "2026", "08", "31");
  await mkdir(parentDir, { recursive: true });
  await mkdir(childDir, { recursive: true });
  await mkdir(join(root, "skills", "caveman"), { recursive: true });
  await writeFile(join(root, "skills", "caveman", "SKILL.md"), "---\nname: caveman\ndescription: Test\n---\n");
  const parentPath = join(parentDir, "rollout-2026-08-30T01-00-00-parent.jsonl");
  await writeFile(parentPath, [
    JSON.stringify({ type: "session_meta", payload: { id: "parent", cwd: root, source: "vscode" } }),
    JSON.stringify({ timestamp: "2026-08-30T01:00:00.000Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "$caveman" }] } }),
  ].join("\n") + "\n");
  await utimes(parentPath, new Date("2026-08-30T02:00:00.000Z"), new Date("2026-08-30T02:00:00.000Z"));
  await writeFile(join(childDir, "rollout-2026-08-31T01-00-00-child.jsonl"), [
    JSON.stringify({ type: "session_meta", payload: { id: "child", cwd: root, source: "vscode", forked_from_id: "parent" } }),
    JSON.stringify({ timestamp: "2026-08-31T01:00:00.000Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "$caveman" }] } }),
  ].join("\n") + "\n");
  const request = {
    range: { kind: "bounded" as const, from: "2026-08-31T00:00:00.000Z", untilExclusive: "2026-09-01T00:00:00.000Z" },
    timezone: "UTC", codexHome: root, jobs: 1 as const,
  };
  const scan = await new CodexSkillScanner().scan(request);
  const report = analyzeSkillUsage(request, scan, "1.0.0");
  assert.equal(scan.sourceStats.filesScanned, 2);
  assert.equal(report.summary.requests, 0);
  assert.equal(report.coverage.unresolved_request_candidates, 0);
});

test("keeps a child no-call-id Load only when it is a new turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "skillusage-load-lineage-"));
  const skillPath = join(root, "skills", "caveman", "SKILL.md");
  await mkdir(join(root, "sessions"), { recursive: true });
  await mkdir(join(root, "skills", "caveman"), { recursive: true });
  await writeFile(skillPath, "---\nname: caveman\ndescription: Test\n---\n");
  const load = (turn: string, timestamp: string) => [
    JSON.stringify({ type: "turn_context", payload: { turn_id: turn } }),
    JSON.stringify({ timestamp, payload: { item: { type: "CommandExecution", status: "completed", exit_code: 0, command: `cat ${skillPath}` } } }),
  ];
  await writeFile(join(root, "sessions", "parent.jsonl"), [
    JSON.stringify({ type: "session_meta", payload: { id: "parent", cwd: root, source: "vscode" } }),
    ...load("copied-turn", "2026-08-31T01:00:00.000Z"),
  ].join("\n") + "\n");
  await writeFile(join(root, "sessions", "child.jsonl"), [
    JSON.stringify({ type: "session_meta", payload: { id: "child", cwd: root, source: "vscode", forked_from_id: "parent" } }),
    ...load("copied-turn", "2026-08-31T02:00:00.000Z"),
    ...load("new-child-turn", "2026-08-31T03:00:00.000Z"),
  ].join("\n") + "\n");
  const reports = new Set<string>();
  for (const jobs of [1, 2, 3, 4] as const) {
    const request = {
      range: { kind: "bounded" as const, from: "2026-08-31T00:00:00.000Z", untilExclusive: "2026-09-01T00:00:00.000Z" },
      timezone: "UTC", codexHome: root, jobs,
    };
    const without = await new CodexSkillScanner().scan({ ...request, includeRequested: false });
    const withRequests = await new CodexSkillScanner().scan({ ...request, includeRequested: true });
    const withoutReport = analyzeSkillUsage(request, without, "1.0.0");
    const withReport = analyzeSkillUsage(request, withRequests, "1.0.0");
    assert.equal(withoutReport.summary.loads, 2);
    assert.equal(withReport.summary.loads, 2);
    assert.deepEqual(withoutReport.skills, withReport.skills);
    reports.add(renderJson(withReport));
  }
  assert.equal(reports.size, 1);
});

test("keeps ambiguous no-call-id fork Loads but exposes incomplete coverage", async () => {
  const root = await mkdtemp(join(tmpdir(), "skillusage-load-ambiguous-lineage-"));
  const skillPath = join(root, "skills", "caveman", "SKILL.md");
  await mkdir(join(root, "sessions"), { recursive: true });
  await mkdir(join(root, "skills", "caveman"), { recursive: true });
  await writeFile(skillPath, "---\nname: caveman\ndescription: Test\n---\n");
  const load = (timestamp: string) => JSON.stringify({
    timestamp, payload: { item: { type: "CommandExecution", status: "completed", exit_code: 0, command: `cat ${skillPath}` } },
  });
  await writeFile(join(root, "sessions", "parent.jsonl"), [
    JSON.stringify({ type: "session_meta", payload: { id: "parent", cwd: root, source: "vscode" } }),
    JSON.stringify({ type: "task_started" }),
    load("2026-08-31T01:00:00.000Z"),
  ].join("\n") + "\n");
  await writeFile(join(root, "sessions", "child.jsonl"), [
    JSON.stringify({ type: "session_meta", payload: { id: "child", cwd: root, source: "vscode", forked_from_id: "parent" } }),
    JSON.stringify({ type: "task_started" }),
    load("2026-08-31T02:00:00.000Z"),
  ].join("\n") + "\n");
  const request = {
    range: { kind: "bounded" as const, from: "2026-08-31T00:00:00.000Z", untilExclusive: "2026-09-01T00:00:00.000Z" },
    timezone: "UTC", codexHome: root, jobs: 1 as const,
  };
  const report = analyzeSkillUsage(request, await new CodexSkillScanner().scan(request), "1.0.0");
  assert.equal(report.summary.loads, 2);
  assert.equal(report.coverage.unresolved_load_candidates, 1);
  assert.equal(report.coverage.history_complete, false);
});

test("scans successful CommandExecution entry read against current inventory", async () => {
  const root = await mkdtemp(join(tmpdir(), "skillusage-"));
  const skillPath = join(root, "skills", "brainstorming", "SKILL.md");
  await mkdir(join(root, "sessions", "2026", "08", "31"), { recursive: true });
  await mkdir(join(root, "skills", "brainstorming"), { recursive: true });
  await writeFile(skillPath, "---\nname: brainstorming\ndescription: Test\n---\n");
  await writeFile(
    join(root, "sessions", "2026", "08", "31", "rollout.jsonl"),
    [
      JSON.stringify({ type: "session_meta", payload: { id: "s-1", cwd: root } }),
      JSON.stringify({ type: "turn_context", payload: { turn_id: "t-1" } }),
      JSON.stringify({
        timestamp: "2026-08-31T02:00:00.000Z",
        type: "event_msg",
        payload: {
          type: "item_completed",
          item: {
            type: "CommandExecution",
            status: "completed",
            exit_code: 0,
            command: `cat ${skillPath}`,
          },
        },
      }),
    ].join("\n") + "\n",
  );

  const scan = await new CodexSkillScanner().scan({
    range: {
      kind: "bounded",
      from: "2026-08-31T00:00:00.000Z",
      untilExclusive: "2026-09-01T00:00:00.000Z",
    },
    timezone: "UTC",
    codexHome: root,
    jobs: 1,
  });

  assert.equal(scan.sourceStats.filesScanned, 1);
  assert.equal(scan.sessions.length, 1);
  assert.deepEqual(scan.sessions[0]?.loads.map((load) => load.skill.name), ["brainstorming"]);
  assert.equal(scan.sessions[0]?.loads[0]?.turnKey, "t-1");
});

test("does not resolve Git projects when no project filter is requested", async () => {
  const root = await mkdtemp(join(tmpdir(), "skillusage-no-project-"));
  const bin = join(root, "bin");
  const marker = join(root, "git-was-called");
  await mkdir(join(root, "sessions"), { recursive: true });
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, "git"), `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o755 });
  await writeFile(join(root, "sessions", "session.jsonl"), `${JSON.stringify({
    type: "session_meta",
    payload: { id: "s-no-project", cwd: root },
  })}\n`);

  const originalPath = process.env.PATH;
  process.env.PATH = `${bin}:${originalPath ?? ""}`;
  try {
    await new CodexSkillScanner().scan({
      range: { kind: "all", asOf: "2026-08-31T23:59:59.999Z" },
      timezone: "UTC",
      codexHome: root,
      jobs: 1,
    });
  } finally {
    process.env.PATH = originalPath;
  }

  await assert.rejects(access(marker));
});

test("pairs legacy exec_command call and successful result", async () => {
  const root = await mkdtemp(join(tmpdir(), "skillusage-"));
  const skillPath = join(root, "skills", "legacy", "SKILL.md");
  await mkdir(join(root, "sessions"), { recursive: true });
  await mkdir(join(root, "skills", "legacy"), { recursive: true });
  await writeFile(skillPath, "---\nname: legacy\ndescription: Test\n---\n");
  await writeFile(
    join(root, "sessions", "legacy.jsonl"),
    [
      JSON.stringify({ type: "session_meta", payload: { id: "s-legacy", cwd: root } }),
      JSON.stringify({ type: "turn_context", payload: { turn_id: "t-legacy" } }),
      JSON.stringify({ timestamp: "2026-08-31T02:00:00.000Z", type: "response_item", payload: { type: "function_call", name: "exec_command", call_id: "c-1", arguments: JSON.stringify({ cmd: `cat ${skillPath}` }) } }),
      JSON.stringify({ timestamp: "2026-08-31T02:01:00.000Z", type: "response_item", payload: { type: "function_call_output", call_id: "c-1", output: JSON.stringify({ exit_code: 0 }) } }),
    ].join("\n") + "\n",
  );
  const scan = await new CodexSkillScanner().scan({
    range: { kind: "bounded", from: "2026-08-31T00:00:00.000Z", untilExclusive: "2026-09-01T00:00:00.000Z" },
    timezone: "UTC", codexHome: root, jobs: 1,
  });
  assert.equal(scan.sessions[0]?.loads[0]?.skill.name, "legacy");
});

test("deduplicates call_id only among sources selected for requested date range", async () => {
  const root = await mkdtemp(join(tmpdir(), "skillusage-fork-"));
  const skillPath = join(root, "skills", "caveman", "SKILL.md");
  await mkdir(join(root, "sessions", "2026", "08", "31"), { recursive: true });
  await mkdir(join(root, "archived_sessions", "2026", "08", "01"), { recursive: true });
  await mkdir(join(root, "skills", "caveman"), { recursive: true });
  await writeFile(skillPath, "---\nname: caveman\ndescription: Test\n---\n");
  const call = JSON.stringify({
    timestamp: "2026-08-01T02:00:00.000Z",
    type: "response_item",
    payload: {
      type: "custom_tool_call", name: "exec", call_id: "fork-call",
      input: `const r = await tools.exec_command({ cmd: ${JSON.stringify(`sed -n '1,20p' ${skillPath} && git status --short`)} }); text(r.output);`,
    },
  });
  const output = JSON.stringify({
    timestamp: "2026-08-01T02:00:01.000Z",
    type: "response_item",
    payload: {
      type: "custom_tool_call_output", call_id: "fork-call",
      output: [{ type: "text", text: "Script completed\n---\nname: caveman\ndescription: Test\n---" }],
    },
  });
  const original = [
    JSON.stringify({ type: "session_meta", payload: { id: "original", cwd: root } }),
    JSON.stringify({ type: "turn_context", payload: { turn_id: "t-original" } }), call, output,
  ].join("\n") + "\n";
  const fork = [
    JSON.stringify({ type: "session_meta", payload: { id: "fork", cwd: root } }),
    JSON.stringify({ type: "turn_context", payload: { turn_id: "t-fork" } }),
    call.replace("2026-08-01", "2026-08-31"), output.replaceAll("2026-08-01", "2026-08-31"),
  ].join("\n") + "\n";
  const originalPath = join(root, "archived_sessions", "2026", "08", "01", "original.jsonl");
  await writeFile(originalPath, original);
  await utimes(originalPath, new Date("2026-08-01T00:00:00.000Z"), new Date("2026-08-01T00:00:00.000Z"));
  await writeFile(join(root, "sessions", "2026", "08", "31", "fork.jsonl"), fork);
  const all = await new CodexSkillScanner().scan({
    range: { kind: "all", asOf: "2026-09-01T00:00:00.000Z" },
    timezone: "UTC", codexHome: root, jobs: 1,
  });
  assert.equal(all.sessions.flatMap((session) => session.loads).length, 1);
  const scan = await new CodexSkillScanner().scan({
    range: { kind: "bounded", from: "2026-08-31T00:00:00.000Z", untilExclusive: "2026-09-01T00:00:00.000Z" },
    timezone: "UTC", codexHome: root, jobs: 1,
  });
  assert.equal(analyzeSkillUsage({
    range: { kind: "bounded", from: "2026-08-31T00:00:00.000Z", untilExclusive: "2026-09-01T00:00:00.000Z" },
    timezone: "UTC", codexHome: root, jobs: 1,
  }, scan, "0.1.0").summary.loads, 1);
});

test("does not add unresolved candidate outside requested date range", async () => {
  const root = await mkdtemp(join(tmpdir(), "skillusage-quality-range-"));
  await mkdir(join(root, "sessions"), { recursive: true });
  await writeFile(join(root, "sessions", "quality.jsonl"), [
    JSON.stringify({ type: "session_meta", payload: { id: "quality", cwd: root } }),
    JSON.stringify({ type: "turn_context", payload: { turn_id: "t-quality" } }),
    JSON.stringify({ timestamp: "2026-08-01T02:00:00.000Z", type: "response_item", payload: { type: "function_call", name: "exec_command", call_id: "unknown", arguments: JSON.stringify({ cmd: "python3 read.py /skills/missing/SKILL.md" }) } }),
  ].join("\n") + "\n");
  const scan = await new CodexSkillScanner().scan({
    range: { kind: "bounded", from: "2026-08-31T00:00:00.000Z", untilExclusive: "2026-09-01T00:00:00.000Z" },
    timezone: "UTC", codexHome: root, jobs: 1,
  });
  assert.equal(scan.sessions[0]?.unresolvedLoadCandidates, 0);
});

test("uses structured parsed_cmd read entries from current CommandExecution", async () => {
  const root = await mkdtemp(join(tmpdir(), "skillusage-"));
  const skillPath = join(root, "skills", "parsed", "SKILL.md");
  await mkdir(join(root, "sessions"), { recursive: true });
  await mkdir(join(root, "skills", "parsed"), { recursive: true });
  await writeFile(skillPath, "---\nname: parsed\ndescription: Test\n---\n");
  await writeFile(join(root, "sessions", "parsed.jsonl"), [
    JSON.stringify({ type: "session_meta", payload: { id: "s-parsed", cwd: root } }),
    JSON.stringify({ type: "turn_context", payload: { turn_id: "t-parsed" } }),
    JSON.stringify({ timestamp: "2026-08-31T02:00:00.000Z", type: "event_msg", payload: { type: "item_completed", item: { type: "CommandExecution", status: "completed", exit_code: 0, command: ["ignored"], parsed_cmd: [{ type: "read", cmd: `sed -n '1,20p' ${skillPath}`, path: skillPath }] } } }),
  ].join("\n") + "\n");
  const scan = await new CodexSkillScanner().scan({
    range: { kind: "bounded", from: "2026-08-31T00:00:00.000Z", untilExclusive: "2026-09-01T00:00:00.000Z" },
    timezone: "UTC", codexHome: root, jobs: 1,
  });
  assert.equal(scan.sessions[0]?.loads[0]?.skill.name, "parsed");
});

test("resolves unique project selector into report-ready ProjectRef", async () => {
  const root = await mkdtemp(join(tmpdir(), "skillusage-project-scan-"));
  const skillPath = join(root, "skills", "project", "SKILL.md");
  await mkdir(join(root, "sessions"), { recursive: true });
  await mkdir(join(root, "skills", "project"), { recursive: true });
  await writeFile(skillPath, "---\nname: project\ndescription: Test\n---\n");
  await mkdir(join(root, ".agents", "skills", "local"), { recursive: true });
  await writeFile(join(root, ".agents", "skills", "local", "SKILL.md"), "---\nname: local\ndescription: Test\n---\n");
  await writeFile(join(root, "sessions", "project.jsonl"), [
    JSON.stringify({ type: "session_meta", payload: { id: "s-project", cwd: root } }),
    JSON.stringify({ type: "turn_context", payload: { turn_id: "t-project" } }),
    JSON.stringify({ timestamp: "2026-08-31T02:00:00.000Z", payload: { item: { type: "CommandExecution", status: "completed", exit_code: 0, command: `cat ${join(root, ".agents", "skills", "local", "SKILL.md")}` } } }),
  ].join("\n") + "\n");
  const scan = await new CodexSkillScanner().scan({
    range: { kind: "bounded", from: "2026-08-31T00:00:00.000Z", untilExclusive: "2026-09-01T00:00:00.000Z" },
    timezone: "UTC", codexHome: root, jobs: 1, projectSelector: basename(root),
  });
  assert.equal(scan.project?.name, basename(root));
  assert.ok(scan.inventory.skills.some((skill) => skill.name === "local"));
  assert.equal(scan.sessions[0]?.loads[0]?.skill.name, "local");
});

test("keeps oversized irrelevant record out of coverage but flags relevant unknown record", async () => {
  const root = await mkdtemp(join(tmpdir(), "skillusage-large-"));
  await mkdir(join(root, "sessions"), { recursive: true });
  const padding = "x".repeat(8 * 1024 * 1024 + 10);
  await writeFile(join(root, "sessions", "irrelevant.jsonl"), `${padding}\n`);
  const baseRequest = {
    range: { kind: "bounded" as const, from: "2026-08-31T00:00:00.000Z", untilExclusive: "2026-09-01T00:00:00.000Z" },
    timezone: "UTC", codexHome: root, jobs: 1 as const,
  };
  let scan = await new CodexSkillScanner().scan(baseRequest);
  assert.equal(scan.sessions[0]?.unreadableRecords, 0);

  await writeFile(join(root, "sessions", "requested.jsonl"), `${padding} $caveman\n`);
  scan = await new CodexSkillScanner().scan(baseRequest);
  assert.ok(scan.sessions.some((session) => session.unreadableRecords === 1));
  assert.equal(scan.sourceStats.requestUnreadableRecords, 1);

  await writeFile(join(root, "sessions", "relevant.jsonl"), `${padding} CommandExecution\n`);
  scan = await new CodexSkillScanner().scan(baseRequest);
  assert.equal(scan.sessions.filter((session) => session.unreadableRecords === 1).length, 2);
});

test("uses raw bytes for the oversized EOF boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "skillusage-large-eof-"));
  await mkdir(join(root, "sessions"), { recursive: true });
  const path = join(root, "sessions", "irrelevant.jsonl");
  await writeFile(path, Buffer.concat([
    Buffer.alloc(8 * 1024 * 1024, 0x78),
    Buffer.from([0xe2]),
  ]));
  const scan = await new CodexSkillScanner().scan({
    range: { kind: "all", asOf: "2026-08-31T23:59:59.999Z" },
    timezone: "UTC",
    codexHome: root,
    jobs: 1,
  });
  assert.equal(scan.sessions[0]?.unreadableRecords, 0);
});

test("marks a same-size mtime change after source freezing as unreadable", async () => {
  const root = await mkdtemp(join(tmpdir(), "skillusage-rewritten-"));
  await mkdir(join(root, "sessions"), { recursive: true });
  const path = join(root, "sessions", "session.jsonl");
  await writeFile(path, `${JSON.stringify({ type: "session_meta", payload: { id: "before", cwd: root } })}\n`);
  const frozen = await stat(path);
  await utimes(path, new Date(0), new Date(0));
  const result = await scanFile(
    { path, sizeBytes: frozen.size, mtimeMs: frozen.mtimeMs, ordinal: 0 },
    { range: { kind: "all", asOf: "2026-08-31T23:59:59.999Z" }, timezone: "UTC", codexHome: root, jobs: 1 },
    await resolveInventory(root),
  );
  assert.equal(result.sessions[0]?.unreadableRecords, 1);
});

test("uses task_started turn fallback when turn_context is absent", async () => {
  const root = await mkdtemp(join(tmpdir(), "skillusage-turn-"));
  const skillPath = join(root, "skills", "fallback", "SKILL.md");
  await mkdir(join(root, "sessions"), { recursive: true });
  await mkdir(join(root, "skills", "fallback"), { recursive: true });
  await writeFile(skillPath, "---\nname: fallback\ndescription: Test\n---\n");
  await writeFile(join(root, "sessions", "fallback.jsonl"), [
    JSON.stringify({ type: "session_meta", payload: { id: "s-fallback", cwd: root } }),
    JSON.stringify({ type: "task_started" }),
    JSON.stringify({ timestamp: "2026-08-31T02:00:00.000Z", payload: { item: { type: "CommandExecution", status: "completed", exit_code: 0, command: `cat ${skillPath}` } } }),
  ].join("\n") + "\n");
  const scan = await new CodexSkillScanner().scan({
    range: { kind: "bounded", from: "2026-08-31T00:00:00.000Z", untilExclusive: "2026-09-01T00:00:00.000Z" },
    timezone: "UTC", codexHome: root, jobs: 1,
  });
  assert.equal(scan.sessions[0]?.loads[0]?.turnKey, "task-started-1");
});

test("merges duplicate active and archived Session keys", async () => {
  const root = await mkdtemp(join(tmpdir(), "skillusage-duplicate-"));
  const skillPath = join(root, "skills", "same", "SKILL.md");
  await mkdir(join(root, "sessions"), { recursive: true });
  await mkdir(join(root, "archived_sessions"), { recursive: true });
  await mkdir(join(root, "skills", "same"), { recursive: true });
  await writeFile(skillPath, "---\nname: same\ndescription: Test\n---\n");
  const record = [
    JSON.stringify({ type: "session_meta", payload: { id: "same-session", cwd: root } }),
    JSON.stringify({ type: "turn_context", payload: { turn_id: "same-turn" } }),
    JSON.stringify({ timestamp: "2026-08-31T02:00:00.000Z", payload: { item: { type: "CommandExecution", status: "completed", exit_code: 0, command: `cat ${skillPath}` } } }),
  ].join("\n") + "\n";
  await writeFile(join(root, "sessions", "active.jsonl"), record);
  await writeFile(join(root, "archived_sessions", "archived.jsonl"), record);
  const scan = await new CodexSkillScanner().scan({
    range: { kind: "bounded", from: "2026-08-31T00:00:00.000Z", untilExclusive: "2026-09-01T00:00:00.000Z" },
    timezone: "UTC", codexHome: root, jobs: 1,
  });
  assert.equal(scan.sessions.length, 1);
});

test("does not infer a read from successful fallback control flow without node evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "skillusage-control-flow-"));
  const skillPath = join(root, "skills", "guarded", "SKILL.md");
  await mkdir(join(root, "sessions"), { recursive: true });
  await mkdir(join(root, "skills", "guarded"), { recursive: true });
  await writeFile(skillPath, "---\nname: guarded\ndescription: Test\n---\n");
  await writeFile(join(root, "sessions", "guarded.jsonl"), [
    JSON.stringify({ type: "session_meta", payload: { id: "guarded-session", cwd: root } }),
    JSON.stringify({ type: "turn_context", payload: { turn_id: "guarded-turn" } }),
    JSON.stringify({ timestamp: "2026-08-31T02:00:00.000Z", payload: { item: { type: "CommandExecution", status: "completed", exit_code: 0, command: `cat ${skillPath} || true` } } }),
  ].join("\n") + "\n");

  const scan = await new CodexSkillScanner().scan({
    range: { kind: "bounded", from: "2026-08-31T00:00:00.000Z", untilExclusive: "2026-09-01T00:00:00.000Z" },
    timezone: "UTC", codexHome: root, jobs: 1,
  });
  assert.equal(scan.sessions[0]?.loads.length, 0);
  assert.equal(scan.sessions[0]?.unresolvedLoadCandidates, 1);
});

test("keeps proven read when another relevant command node remains unknown", async () => {
  const root = await mkdtemp(join(tmpdir(), "skillusage-local-node-"));
  const skillPath = join(root, "skills", "local", "SKILL.md");
  await mkdir(join(root, "sessions"), { recursive: true });
  await mkdir(join(root, "skills", "local"), { recursive: true });
  await writeFile(skillPath, "---\nname: local\ndescription: Test\n---\n");
  await writeFile(join(root, "sessions", "local.jsonl"), [
    JSON.stringify({ type: "session_meta", payload: { id: "local-session", cwd: root } }),
    JSON.stringify({ type: "turn_context", payload: { turn_id: "local-turn" } }),
    JSON.stringify({ timestamp: "2026-08-31T02:00:00.000Z", payload: { item: { type: "CommandExecution", status: "completed", exit_code: 0, command: `python3 read.py /tmp/unknown/SKILL.md; cat ${skillPath}` } } }),
  ].join("\n") + "\n");

  const scan = await new CodexSkillScanner().scan({
    range: { kind: "bounded", from: "2026-08-31T00:00:00.000Z", untilExclusive: "2026-09-01T00:00:00.000Z" },
    timezone: "UTC", codexHome: root, jobs: 1,
  });
  assert.deepEqual(scan.sessions[0]?.loads.map((load) => load.skill.name), ["local"]);
  assert.equal(scan.sessions[0]?.unresolvedLoadCandidates, 1);
});

test("uses Session catalog for removed entry paths and pairs one custom exec with multiple Skills", async () => {
  const root = await mkdtemp(join(tmpdir(), "skillusage-session-catalog-"));
  const oldAlpha = join(root, "removed", "alpha", "SKILL.md");
  const oldBeta = join(root, "removed", "beta", "SKILL.md");
  await mkdir(join(root, "sessions"), { recursive: true });
  await writeFile(join(root, "sessions", "catalog.jsonl"), [
    JSON.stringify({
      type: "session_meta",
      payload: {
        id: "catalog-session", cwd: root,
        base_instructions: { text: `<skills><name>alpha</name><path>${oldAlpha}</path><name>beta</name><path>${oldBeta}</path></skills>` },
      },
    }),
    JSON.stringify({ type: "turn_context", payload: { turn_id: "catalog-turn" } }),
    JSON.stringify({
      timestamp: "2026-08-31T02:00:00.000Z", type: "response_item",
      payload: {
        type: "custom_tool_call", name: "exec", call_id: "multi-custom",
        input: `const a = await tools.exec_command({ cmd: ${JSON.stringify(`cat ${oldAlpha}`)} }); const b = await tools.exec_command({ cmd: ${JSON.stringify(`cat ${oldBeta}`)} });`,
      },
    }),
    JSON.stringify({ timestamp: "2026-08-31T02:00:01.000Z", type: "response_item", payload: { type: "custom_tool_call_output", call_id: "multi-custom", output: "{\"exit_code\":0}" } }),
  ].join("\n") + "\n");

  const scan = await new CodexSkillScanner().scan({
    range: { kind: "bounded", from: "2026-08-31T00:00:00.000Z", untilExclusive: "2026-09-01T00:00:00.000Z" },
    timezone: "UTC", codexHome: root, jobs: 1,
  });
  assert.deepEqual(scan.sessions[0]?.loads.map((load) => load.skill.name).sort(), ["alpha", "beta"]);
});

test("keeps no-call-ID reads deduped by Turn and canonical across jobs 1 through 4", async () => {
  const root = await mkdtemp(join(tmpdir(), "skillusage-canonical-jobs-"));
  const skillPath = join(root, "skills", "turn-only", "SKILL.md");
  await mkdir(join(root, "sessions", "2026", "08", "31"), { recursive: true });
  await mkdir(join(root, "sessions", "2026", "08", "30"), { recursive: true });
  await mkdir(join(root, "skills", "turn-only"), { recursive: true });
  await writeFile(skillPath, "---\nname: turn-only\ndescription: Test\n---\n");
  const session = (id: string, turn: string, timestamp: string) => [
    JSON.stringify({ type: "session_meta", payload: { id, cwd: root } }),
    JSON.stringify({ type: "turn_context", payload: { turn_id: turn } }),
    JSON.stringify({ timestamp, payload: { item: { type: "CommandExecution", status: "completed", exit_code: 0, command: `cat ${skillPath}` } } }),
    JSON.stringify({ timestamp, payload: { item: { type: "CommandExecution", status: "completed", exit_code: 0, command: `cat ${skillPath}` } } }),
  ].join("\n") + "\n";
  await writeFile(join(root, "sessions", "2026", "08", "30", "one.jsonl"), session("one", "turn-one", "2026-08-30T02:00:00.000Z"));
  await writeFile(join(root, "sessions", "2026", "08", "31", "two.jsonl"), session("two", "turn-two", "2026-08-31T02:00:00.000Z"));

  const outputs = new Set<string>();
  for (const jobs of [1, 2, 3, 4] as const) {
    const request = { range: { kind: "bounded" as const, from: "2026-08-30T00:00:00.000Z", untilExclusive: "2026-09-01T00:00:00.000Z" }, timezone: "UTC", codexHome: root, jobs };
    const report = analyzeSkillUsage(request, await new CodexSkillScanner().scan(request), "0.1.0");
    assert.equal(report.summary.loads, 2);
    outputs.add(renderJson(report));
  }
  assert.equal(outputs.size, 1);
});

test("uses paired custom output entry name when fallback control flow has no structured exit code", async () => {
  const root = await mkdtemp(join(tmpdir(), "skillusage-output-name-"));
  const skillPath = join(root, "skills", "named-output", "SKILL.md");
  await mkdir(join(root, "sessions"), { recursive: true });
  await mkdir(join(root, "skills", "named-output"), { recursive: true });
  await writeFile(skillPath, "---\nname: named-output\ndescription: Test\n---\n");
  await writeFile(join(root, "sessions", "output.jsonl"), [
    JSON.stringify({ type: "session_meta", payload: { id: "output-session", cwd: root } }),
    JSON.stringify({ type: "turn_context", payload: { turn_id: "output-turn" } }),
    JSON.stringify({ timestamp: "2026-08-31T02:00:00.000Z", type: "response_item", payload: { type: "custom_tool_call", name: "exec", call_id: "output-name", input: `const r = await tools.exec_command({ cmd: ${JSON.stringify(`cat ${skillPath} || true`)} }); text(r.output);` } }),
    JSON.stringify({ timestamp: "2026-08-31T02:00:01.000Z", type: "response_item", payload: { type: "custom_tool_call_output", call_id: "output-name", output: "name: named-output" } }),
  ].join("\n") + "\n");

  const scan = await new CodexSkillScanner().scan({
    range: { kind: "bounded", from: "2026-08-31T00:00:00.000Z", untilExclusive: "2026-09-01T00:00:00.000Z" },
    timezone: "UTC", codexHome: root, jobs: 1,
  });
  assert.deepEqual(scan.sessions[0]?.loads.map((load) => load.skill.name), ["named-output"]);
});

test("keeps unknown relevant sibling unresolved even when enclosing command fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "skillusage-failed-unknown-"));
  const skillPath = join(root, "skills", "failed", "SKILL.md");
  await mkdir(join(root, "sessions"), { recursive: true });
  await mkdir(join(root, "skills", "failed"), { recursive: true });
  await writeFile(skillPath, "---\nname: failed\ndescription: Test\n---\n");
  await writeFile(join(root, "sessions", "failed.jsonl"), [
    JSON.stringify({ type: "session_meta", payload: { id: "failed-session", cwd: root } }),
    JSON.stringify({ type: "turn_context", payload: { turn_id: "failed-turn" } }),
    JSON.stringify({ timestamp: "2026-08-31T02:00:00.000Z", payload: { item: { type: "CommandExecution", status: "failed", exit_code: 1, command: `cat ${skillPath}; python3 read.py /tmp/unknown/SKILL.md` } } }),
  ].join("\n") + "\n");

  const scan = await new CodexSkillScanner().scan({
    range: { kind: "bounded", from: "2026-08-31T00:00:00.000Z", untilExclusive: "2026-09-01T00:00:00.000Z" },
    timezone: "UTC", codexHome: root, jobs: 1,
  });
  assert.equal(scan.sessions[0]?.loads.length, 0);
  assert.equal(scan.sessions[0]?.unresolvedLoadCandidates, 1);
});
