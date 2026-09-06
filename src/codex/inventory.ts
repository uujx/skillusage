import { realpath } from "node:fs/promises";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, normalize, resolve } from "node:path";

import type { InventoryResult, SkillRef } from "../core/types.js";
import { skillId } from "./history.js";

export interface ResolvedInventory {
  result: InventoryResult;
  aliases: ReadonlyMap<string, SkillRef>;
  acceptedRoots: readonly string[];
}

async function existsDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function skillName(entry: string): Promise<string | undefined> {
  try {
    const text = await readFile(entry, "utf8");
    const match = /^---\r?\n([\s\S]*?)\r?\n---/m.exec(text.slice(0, 65536));
    const name = match?.[1].match(/^name:\s*["']?([^"'\r\n]+)["']?\s*$/m)?.[1]?.trim();
    return name || undefined;
  } catch {
    return undefined;
  }
}

async function disabledEntries(codexHome: string): Promise<{ paths: Set<string>; names: Set<string> }> {
  try {
    const config = await readFile(join(codexHome, "config.toml"), "utf8");
    const paths = new Set<string>();
    const names = new Set<string>();
    for (const block of config.split("[[skills.config]]").slice(1)) {
      if (!/^\s*(?:path|name|enabled)\s*=/m.test(block) || !/^\s*enabled\s*=\s*false\s*$/m.test(block)) continue;
      const path = /^\s*path\s*=\s*"([^"]+)"\s*$/m.exec(block)?.[1];
      const name = /^\s*name\s*=\s*"([^"]+)"\s*$/m.exec(block)?.[1];
      if (path) paths.add(normalize(resolve(path)));
      if (name) names.add(name.normalize("NFKC").toLocaleLowerCase("en-US"));
    }
    return { paths, names };
  } catch {
    return { paths: new Set(), names: new Set() };
  }
}

async function enabledPluginRoots(codexHome: string): Promise<{ roots: string[]; unresolved: number }> {
  let config: string;
  try {
    config = await readFile(join(codexHome, "config.toml"), "utf8");
  } catch {
    return { roots: [], unresolved: 0 };
  }
  const enabled: Array<{ name: string; source: string }> = [];
  const blocks = config.split(/(?=^\[)/m);
  for (const block of blocks) {
    const key = /^\[plugins\."([^"@]+)@([^"@]+)"\]/m.exec(block);
    if (key && /^\s*enabled\s*=\s*true\s*$/m.test(block)) enabled.push({ name: key[1]!, source: key[2]! });
  }
  const roots: string[] = [];
  let unresolved = 0;
  for (const plugin of enabled) {
    const cache = join(codexHome, "plugins", "cache", plugin.source, plugin.name);
    let revisions: string[];
    try {
      revisions = await readdir(cache);
    } catch {
      unresolved += 1;
      continue;
    }
    const uniqueRevisions = new Map<string, string>();
    for (const revision of revisions) {
      try {
        const revisionPath = join(cache, revision);
        uniqueRevisions.set(await realpath(revisionPath), revisionPath);
      } catch {
        unresolved += 1;
      }
    }
    if (uniqueRevisions.size !== 1) {
      unresolved += 1;
      continue;
    }
    const revisionPath = [...uniqueRevisions.values()][0]!;
    try {
      const manifest = JSON.parse(await readFile(join(revisionPath, ".codex-plugin", "plugin.json"), "utf8")) as { skills?: unknown };
      if (manifest.skills === undefined) continue;
      if (typeof manifest.skills !== "string" || isAbsolute(manifest.skills)) {
        unresolved += 1;
        continue;
      }
      const skillRoot = join(revisionPath, manifest.skills);
      if (await existsDirectory(skillRoot)) roots.push(skillRoot);
      else unresolved += 1;
    } catch {
      unresolved += 1;
    }
  }
  return { roots, unresolved };
}

async function discoverRoot(root: string): Promise<Array<{ entry: string; name: string }>> {
  if (!(await existsDirectory(root))) return [];
  const found: Array<{ entry: string; name: string }> = [];
  const queue = [root];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const current = queue.pop();
    if (!current) continue;
    try {
      const canonical = await realpath(current);
      if (visited.has(canonical)) continue;
      visited.add(canonical);
    } catch {
      continue;
    }
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      const directory = entry.isDirectory() || (entry.isSymbolicLink() && await existsDirectory(path));
      if (directory) queue.push(path);
      if (!directory) continue;
      const skillFile = join(path, "SKILL.md");
      const name = await skillName(skillFile);
      if (name) found.push({ entry: skillFile, name });
    }
  }
  return found;
}

export async function resolveInventory(codexHome: string, projectRoot?: string): Promise<ResolvedInventory> {
  const plugins = await enabledPluginRoots(codexHome);
  const roots = [
    join(homedir(), ".agents", "skills"),
    join(codexHome, "skills"),
    join(codexHome, "skills", ".system"),
    "/etc/codex/skills",
    ...(projectRoot ? [join(projectRoot, ".agents", "skills")] : []),
    ...plugins.roots,
  ].map((path) => resolve(path));
  const disabled = await disabledEntries(codexHome);
  const aliases = new Map<string, SkillRef>();
  let unresolvedSources = plugins.unresolved;
  let readableRoots = 0;
  for (const root of roots) {
    if (await existsDirectory(root)) readableRoots += 1;
    for (const item of await discoverRoot(root)) {
      const lexical = normalize(resolve(item.entry));
      if (disabled.paths.has(lexical) || disabled.names.has(item.name.normalize("NFKC").toLocaleLowerCase("en-US"))) continue;
      let canonical = lexical;
      try {
        canonical = normalize(await realpath(lexical));
      } catch {
        unresolvedSources += 1;
        continue;
      }
      const skill = { id: skillId("codex", item.name), name: item.name };
      aliases.set(lexical, skill);
      aliases.set(canonical, skill);
    }
  }
  const skills = [...new Map([...aliases.values()].map((skill) => [skill.id, skill])).values()]
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
  return {
    result: {
      status: unresolvedSources > 0 ? "partial" : readableRoots === 0 ? "unavailable" : "complete",
      skills,
      unresolvedSources,
    },
    aliases,
    acceptedRoots: roots,
  };
}

export function knownRootSkill(
  entry: string,
  acceptedRoots: readonly string[],
): SkillRef | undefined {
  const canonical = normalize(resolve(entry));
  if (basename(canonical) !== "SKILL.md") return undefined;
  const parent = resolve(canonical, "..");
  const isProjectSkill = /[/\\]\.agents[/\\]skills[/\\][^/\\]+[/\\]SKILL\.md$/.test(canonical);
  if (!isProjectSkill && !acceptedRoots.some((root) => parent.startsWith(`${normalize(root)}/`))) return undefined;
  return { id: skillId("codex", basename(parent)), name: basename(parent) };
}
