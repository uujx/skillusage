import assert from "node:assert/strict";
import { mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import test from "node:test";

import { resolveInventory } from "../../src/codex/inventory.js";

test("discovers a current Skill through a directory symlink", async () => {
  const root = await mkdtemp(join(tmpdir(), "skillusage-inventory-"));
  const target = join(root, "external", "review");
  const linked = join(root, "skills", "review");
  await mkdir(target, { recursive: true });
  await mkdir(join(root, "skills"), { recursive: true });
  await writeFile(join(target, "SKILL.md"), "---\nname: review\ndescription: Test\n---\n");
  await symlink(target, linked);

  const inventory = await resolveInventory(root);

  assert.deepEqual(inventory.result.skills.map((skill) => skill.name), ["review"]);
  assert.ok(inventory.aliases.has(join(root, "skills", "review", "SKILL.md")));
  assert.ok(inventory.aliases.has(await realpath(join(target, "SKILL.md"))));
});

test("excludes Skill disabled by current skills.config path", async () => {
  const root = await mkdtemp(join(tmpdir(), "skillusage-inventory-"));
  const entry = join(root, "skills", "disabled", "SKILL.md");
  await mkdir(join(root, "skills", "disabled"), { recursive: true });
  await writeFile(entry, "---\nname: disabled\ndescription: Test\n---\n");
  await writeFile(join(root, "config.toml"), `[[skills.config]]\npath = "${entry}"\nenabled = false\n`);

  const inventory = await resolveInventory(root);

  assert.deepEqual(inventory.result.skills, []);
});

test("includes enabled plugin Skill only with one valid cached revision", async () => {
  const root = await mkdtemp(join(tmpdir(), "skillusage-plugin-"));
  const revision = join(root, "plugins", "cache", "demo-source", "demo", "1.0.0");
  await mkdir(join(revision, ".codex-plugin"), { recursive: true });
  await mkdir(join(revision, "skills", "plugin-skill"), { recursive: true });
  await writeFile(join(root, "config.toml"), `[plugins."demo@demo-source"]\nenabled = true\n`);
  await writeFile(join(revision, ".codex-plugin", "plugin.json"), JSON.stringify({ skills: "./skills" }));
  await writeFile(join(revision, "skills", "plugin-skill", "SKILL.md"), "---\nname: plugin-skill\ndescription: Test\n---\n");

  const inventory = await resolveInventory(root);

  assert.deepEqual(inventory.result.skills.map((skill) => skill.name), ["plugin-skill"]);
});

test("marks inventory partial when enabled plugin has multiple revisions", async () => {
  const root = await mkdtemp(join(tmpdir(), "skillusage-plugin-"));
  for (const revision of ["1.0.0", "2.0.0"]) {
    const base = join(root, "plugins", "cache", "demo-source", "demo", revision);
    await mkdir(join(base, ".codex-plugin"), { recursive: true });
    await writeFile(join(base, ".codex-plugin", "plugin.json"), JSON.stringify({ skills: "./skills" }));
  }
  await writeFile(join(root, "config.toml"), `[plugins."demo@demo-source"]\nenabled = true\n`);

  const inventory = await resolveInventory(root);

  assert.equal(inventory.result.status, "partial");
  assert.equal(inventory.result.unresolvedSources, 1);
});

test("marks inventory unavailable when no current source is readable", async () => {
  const root = await mkdtemp(join(tmpdir(), "skillusage-empty-"));
  const inventory = await resolveInventory(root);
  assert.equal(inventory.result.status, "unavailable");
});

test("deduplicates latest symlink and accepts plugin with no Skill declaration", async () => {
  const root = await mkdtemp(join(tmpdir(), "skillusage-plugin-current-"));
  const chrome = join(root, "plugins", "cache", "bundled", "chrome", "1.0.0");
  await mkdir(join(chrome, ".codex-plugin"), { recursive: true });
  await mkdir(join(chrome, "skills", "chrome-skill"), { recursive: true });
  await writeFile(join(chrome, ".codex-plugin", "plugin.json"), JSON.stringify({ skills: "./skills" }));
  await writeFile(join(chrome, "skills", "chrome-skill", "SKILL.md"), "---\nname: chrome-skill\ndescription: Test\n---\n");
  await symlink(chrome, join(root, "plugins", "cache", "bundled", "chrome", "latest"));
  const tools = join(root, "plugins", "cache", "bundled", "tools", "1.0.0");
  await mkdir(join(tools, ".codex-plugin"), { recursive: true });
  await writeFile(join(tools, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "tools" }));
  await writeFile(join(root, "config.toml"), [
    "[plugins.\"chrome@bundled\"]", "enabled = true",
    "[plugins.\"tools@bundled\"]", "enabled = true",
  ].join("\n"));

  const inventory = await resolveInventory(root);

  assert.equal(inventory.result.status, "complete");
  assert.equal(inventory.result.unresolvedSources, 0);
  assert.deepEqual(inventory.result.skills.map((skill) => skill.name), ["chrome-skill"]);
});
