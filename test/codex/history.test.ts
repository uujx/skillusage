import assert from "node:assert/strict";
import test from "node:test";

import { classifyReadCommand, skillId } from "../../src/codex/history.js";

test("recognizes Windows entry paths without counting mentions or other files", () => {
  const path = String.raw`C:\Users\runner\skills\demo\SKILL.md`;
  assert.deepEqual(classifyReadCommand(`cat "${path}"`), {
    kind: "reads", paths: [path], successProvenPaths: [path],
  });
  assert.deepEqual(classifyReadCommand(`echo "${path}"`), { kind: "negative" });
  assert.deepEqual(classifyReadCommand(`cat "${path}.bak"`), { kind: "negative" });
  assert.deepEqual(classifyReadCommand(`cat "${path}" || true`), {
    kind: "reads", paths: [path], successProvenPaths: [],
  });
});

test("recognizes supported successful entry reads without executing shell", () => {
  assert.deepEqual(
    classifyReadCommand("sed -n '1,260p' '/skills/brainstorming/SKILL.md'"),
    { kind: "reads", paths: ["/skills/brainstorming/SKILL.md"], successProvenPaths: ["/skills/brainstorming/SKILL.md"] },
  );
  assert.deepEqual(
    classifyReadCommand("cat -- /skills/a/SKILL.md /skills/b/SKILL.md"),
    { kind: "reads", paths: ["/skills/a/SKILL.md", "/skills/b/SKILL.md"], successProvenPaths: ["/skills/a/SKILL.md", "/skills/b/SKILL.md"] },
  );
  assert.deepEqual(classifyReadCommand("head -n 20 /skills/a/SKILL.md && tail -n 4 /skills/b/SKILL.md"), {
    kind: "reads", paths: ["/skills/a/SKILL.md", "/skills/b/SKILL.md"], successProvenPaths: ["/skills/a/SKILL.md", "/skills/b/SKILL.md"],
  });
});

test("rejects path mentions and marks unsupported relevant shell as unresolved", () => {
  assert.deepEqual(classifyReadCommand("echo /skills/a/SKILL.md"), { kind: "negative" });
  assert.deepEqual(classifyReadCommand("sed -i '' 's/x/y/' /skills/a/SKILL.md"), { kind: "negative" });
  assert.deepEqual(classifyReadCommand("awk '{ print }' /skills/a/SKILL.md"), { kind: "unknown" });
  assert.deepEqual(classifyReadCommand("cat /skills/a/SKILL.md | wc -l"), { kind: "reads", paths: ["/skills/a/SKILL.md"], successProvenPaths: [] });
  assert.deepEqual(classifyReadCommand("cat $SKILL"), { kind: "negative" });
  assert.deepEqual(classifyReadCommand("cat /skills/a/SKILL.md > result.txt"), { kind: "unknown" });
});

test("keeps supported read nodes when compound command has unrelated siblings", () => {
  assert.deepEqual(
    classifyReadCommand("sed -n '1,20p' /skills/a/SKILL.md && git status --short"),
    { kind: "reads", paths: ["/skills/a/SKILL.md"], successProvenPaths: ["/skills/a/SKILL.md"] },
  );
  assert.deepEqual(
    classifyReadCommand("wc -l README.md; cat /skills/a/SKILL.md"),
    { kind: "reads", paths: ["/skills/a/SKILL.md"], successProvenPaths: ["/skills/a/SKILL.md"] },
  );
});

test("keeps read candidates but only propagates whole-command success through proven control flow", () => {
  assert.deepEqual(classifyReadCommand("git status && cat /skills/a/SKILL.md"), {
    kind: "reads", paths: ["/skills/a/SKILL.md"], successProvenPaths: ["/skills/a/SKILL.md"],
  });
  assert.deepEqual(classifyReadCommand("cat /skills/a/SKILL.md || true"), {
    kind: "reads", paths: ["/skills/a/SKILL.md"], successProvenPaths: [],
  });
  assert.deepEqual(classifyReadCommand("cat /skills/a/SKILL.md; git status"), {
    kind: "reads", paths: ["/skills/a/SKILL.md"], successProvenPaths: [],
  });
  assert.deepEqual(classifyReadCommand("git status; cat /skills/a/SKILL.md"), {
    kind: "reads", paths: ["/skills/a/SKILL.md"], successProvenPaths: ["/skills/a/SKILL.md"],
  });
  assert.deepEqual(classifyReadCommand("cat /skills/a/SKILL.md && echo done > /tmp/out"), {
    kind: "reads", paths: ["/skills/a/SKILL.md"], successProvenPaths: ["/skills/a/SKILL.md"],
  });
});

test("uses platform and normalized Skill name for stable logical identity", () => {
  assert.equal(
    skillId("codex", " Caveman "),
    skillId("codex", "caveman"),
  );
});
