import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, join, normalize, resolve } from "node:path";
import { Worker } from "node:worker_threads";

import type {
  AnalysisRequest,
  PlatformScanResult,
  PlatformSkillScanner,
  ProgressSnapshot,
  ProjectRef,
  ScannedSession,
} from "../core/types.js";
import { classifyReadCommand, skillId } from "./history.js";
import { knownRootSkill, resolveInventory, type ResolvedInventory } from "./inventory.js";
import { projectFromCwd } from "./project.js";

export interface SessionFile {
  path: string;
  sizeBytes: number;
  mtimeMs: number;
  ordinal: number;
}

export interface FileResult {
  ordinal: number;
  sessions: ScannedSession[];
  bytesScanned: number;
  unreadableRecords: number;
  projectRoots: Array<[string, string]>;
}

const MAX_RECORD_BYTES = 8 * 1024 * 1024;
const sessionSkillCache = new Map<string, Array<{ name: string; path: string }>>();

async function walk(root: string): Promise<string[]> {
  const paths: string[] = [];
  try {
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(root, entry.name);
      if (entry.isDirectory()) paths.push(...await walk(path));
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) paths.push(path);
    }
  } catch {
    return [];
  }
  return paths;
}

function pathStartHint(path: string): number | undefined {
  const match = /\/(\d{4})\/(\d{2})\/(\d{2})\/|rollout-(\d{4})-(\d{2})-(\d{2})T/.exec(path.replaceAll("\\", "/"));
  const [, directoryYear, directoryMonth, directoryDay, fileYear, fileMonth, fileDay] = match ?? [];
  const year = directoryYear ?? fileYear;
  const month = directoryMonth ?? fileMonth;
  const day = directoryDay ?? fileDay;
  return year && month && day ? Date.UTC(Number(year), Number(month) - 1, Number(day)) : undefined;
}

async function discover(codexHome: string, request: AnalysisRequest): Promise<SessionFile[]> {
  const paths = [
    ...await walk(join(codexHome, "sessions")),
    ...await walk(join(codexHome, "archived_sessions")),
  ].sort();
  const files: SessionFile[] = [];
  for (const path of paths) {
    try {
      const info = await stat(path);
      if (request.range.kind === "bounded") {
        const hint = pathStartHint(path);
        const from = Date.parse(request.range.from);
        const until = Date.parse(request.range.untilExclusive);
        if ((hint !== undefined && hint >= until) || (hint !== undefined && hint < from && info.mtimeMs < from)) continue;
      }
      files.push({ path, sizeBytes: info.size, mtimeMs: info.mtimeMs, ordinal: files.length });
    } catch {
      // File disappearance becomes scan-quality data once selected.
    }
  }
  return files;
}

async function firstSessionMeta(file: SessionFile): Promise<Record<string, unknown> | undefined> {
  if (file.sizeBytes === 0) return undefined;
  const stream = createReadStream(file.path, {
    end: Math.min(file.sizeBytes - 1, 1024 * 1024 - 1),
    encoding: "utf8",
  });
  let remainder = "";
  try {
    for await (const chunk of stream) {
      const parts = (remainder + chunk).split("\n");
      remainder = parts.pop() ?? "";
      for (const line of parts) {
        if (!line) continue;
        try {
          const root = JSON.parse(line) as Record<string, unknown>;
          const payload = asObject(root.payload);
          if (root.type === "session_meta" || payload?.type === "session_meta") return payload ?? root;
        } catch { /* keep searching the bounded prefix */ }
      }
    }
  } finally {
    stream.destroy();
  }
  return undefined;
}

async function expandLineageParents(files: SessionFile[], codexHome: string): Promise<SessionFile[]> {
  const selected = new Map(files.map((file) => [file.path, file]));
  const metaByPath = new Map<string, Record<string, unknown>>();
  const parentIds = new Set<string>();
  const inspect = async (file: SessionFile) => {
    const meta = await firstSessionMeta(file);
    if (!meta) return;
    metaByPath.set(file.path, meta);
    const parent = metaParentSessionKey(meta);
    if (parent) parentIds.add(parent);
  };
  for (const file of files) await inspect(file);
  if (parentIds.size === 0) return files;

  const allPaths = [
    ...await walk(join(codexHome, "sessions")),
    ...await walk(join(codexHome, "archived_sessions")),
  ].sort();
  const unresolved = new Set(parentIds);
  for (;;) {
    const needed = [...unresolved];
    if (needed.length === 0) break;
    unresolved.clear();
    let added = false;
    for (const parentId of needed) {
      const matches = allPaths.filter((path) => path.includes(parentId));
      for (const path of matches) {
        if (selected.has(path)) continue;
        try {
          const info = await stat(path);
          const file: SessionFile = { path, sizeBytes: info.size, mtimeMs: info.mtimeMs, ordinal: 0 };
          const meta = await firstSessionMeta(file);
          if (textAt(meta ?? {}, "id") !== parentId) continue;
          selected.set(path, file);
          metaByPath.set(path, meta!);
          const grandparent = metaParentSessionKey(meta!);
          if (grandparent) unresolved.add(grandparent);
          added = true;
        } catch { /* unavailable auxiliary source remains unresolved later */ }
      }
    }
    if (!added) break;
  }
  return [...selected.values()]
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((file, ordinal) => ({ ...file, ordinal }));
}

async function* lines(
  path: string,
  sizeLimit: number,
  frozenSize: number,
  onBytes?: (delta: number) => void,
): AsyncGenerator<{ text?: string; relevant: boolean }> {
  const stream = createReadStream(path, {
    highWaterMark: 64 * 1024,
    encoding: undefined,
    ...(frozenSize > 0 ? { end: frozenSize - 1 } : {}),
  });
  const marker = /CommandExecution|function_call|SKILL\.md|turn_context|session_meta|\$[a-z][a-z0-9-]*/i;
  let pieces: Buffer[] = [];
  let recordBytes = 0;
  let oversized = false;
  let relevant = false;
  let markerTail = "";
  const reset = () => {
    pieces = [];
    recordBytes = 0;
    oversized = false;
    relevant = false;
    markerTail = "";
  };
  const inspectMarker = (text: string) => {
    const candidate = markerTail + text;
    relevant ||= marker.test(candidate);
    markerTail = candidate.slice(-64);
  };
  for await (const chunk of stream) {
    const bytes = chunk as Buffer;
    onBytes?.(bytes.byteLength);
    let offset = 0;
    while (offset < bytes.length) {
      const newline = bytes.indexOf(0x0a, offset);
      const end = newline === -1 ? bytes.length : newline;
      const piece = bytes.subarray(offset, end);
      recordBytes += piece.length;
      if (oversized) {
        inspectMarker(piece.toString("utf8"));
      } else {
        pieces.push(piece);
        if (recordBytes > sizeLimit) {
          oversized = true;
          inspectMarker(Buffer.concat(pieces, recordBytes).toString("utf8"));
          pieces = [];
        }
      }
      if (newline !== -1) {
        if (oversized) yield { relevant };
        else yield { text: Buffer.concat(pieces, recordBytes).toString("utf8"), relevant: false };
        reset();
        offset = newline + 1;
      } else {
        offset = bytes.length;
      }
    }
  }
  if (oversized) yield { relevant };
  else if (recordBytes > 0) yield { text: Buffer.concat(pieces, recordBytes).toString("utf8"), relevant: false };
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function nestedCommandExecutions(value: unknown, found: Record<string, unknown>[] = []): Record<string, unknown>[] {
  const record = asObject(value);
  if (!record) return found;
  if (record.type === "CommandExecution") found.push(record);
  for (const nested of Object.values(record)) nestedCommandExecutions(nested, found);
  return found;
}

function textAt(record: Record<string, unknown>, key: string): string | undefined {
  return typeof record[key] === "string" ? record[key] : undefined;
}

function messageText(payload: Record<string, unknown>): string | undefined {
  if (!Array.isArray(payload.content)) return undefined;
  const parts = payload.content.flatMap((block) => {
    const value = asObject(block);
    return value?.type === "input_text" && typeof value.text === "string" ? [value.text] : [];
  });
  return parts.length > 0 ? parts.join("\n") : undefined;
}

function requestTokens(text: string): string[] {
  return [...new Set([...text.matchAll(/\$([a-z][a-z0-9-]*)\b/g)].map((match) => match[1]!.normalize("NFKC").toLocaleLowerCase("en-US")))];
}

function requestFingerprint(text: string): string {
  return createHash("sha256").update(text.normalize("NFKC").replace(/\s+/g, " ").trim()).digest("hex");
}

function metaParentSessionKey(meta: Record<string, unknown>): string | undefined {
  const source = asObject(meta.source);
  const subagent = asObject(source?.subagent);
  const spawned = asObject(subagent?.thread_spawn);
  return textAt(spawned ?? {}, "parent_thread_id") ?? textAt(meta, "forked_from_id");
}

function metaIsSubagent(meta: Record<string, unknown>): boolean {
  return Boolean(asObject(asObject(meta.source)?.subagent));
}

function isGeneratedUserMessage(text: string): boolean {
  const trimmed = text.trimStart();
  return /^<codex_internal_context\b[^>]*\bsource="goal"/.test(trimmed) || trimmed.startsWith("<skill>");
}

function resolveSkill(path: string, cwd: string | undefined, inventory: ResolvedInventory) {
  const entry = normalize(resolve(cwd ?? "/", path));
  return inventory.aliases.get(entry) ?? knownRootSkill(entry, inventory.acceptedRoots);
}

function sessionSkillEntries(value: unknown): Array<{ name: string; path: string }> {
  const entries: Array<{ name: string; path: string }> = [];
  const record = asObject(value);
  const base = asObject(record?.base_instructions);
  const texts = [textAt(base ?? {}, "text"), textAt(record ?? {}, "skills")].filter((text): text is string => Boolean(text));
  for (const text of texts) {
    const cached = sessionSkillCache.get(text);
    if (cached) {
      entries.push(...cached);
      continue;
    }
    if (!text.includes("SKILL.md")) continue;
    const parsed: Array<{ name: string; path: string }> = [];
    for (const match of text.matchAll(/<name>\s*([^<\r\n]+)\s*<\/name>[\s\S]{0,2000}?<path>\s*([^<\r\n]+[/\\]SKILL\.md)\s*<\/path>/g)) parsed.push({ name: match[1]!.trim(), path: match[2]!.trim() });
    for (const match of text.matchAll(/(?:^|\n)\s*-\s*([^\n(]{1,100}).*?\(file:\s*([^\s)]+[/\\]SKILL\.md)\)/g)) parsed.push({ name: match[1]!.trim(), path: match[2]!.trim() });
    sessionSkillCache.set(text, parsed);
    entries.push(...parsed);
  }
  return entries;
}

function outputText(payload: Record<string, unknown>): string {
  if (typeof payload.output === "string") return payload.output;
  if (!Array.isArray(payload.output)) return "";
  return payload.output.map((block) => asObject(block)?.text).filter((text): text is string => typeof text === "string").join("\n");
}

function outputSkillNames(output: string): Set<string> {
  return new Set([...output.matchAll(/(?:^|\n)name:\s*["']?([^"'\r\n]+)["']?\s*$/gm)]
    .map((match) => match[1]?.trim().normalize("NFKC").toLocaleLowerCase("en-US"))
    .filter((name): name is string => Boolean(name)));
}

function customExecCommands(input: string): Array<{ command: string; cwd?: string }> {
  const commands: Array<{ command: string; cwd?: string }> = [];
  for (const match of input.matchAll(/tools\.exec_command\s*\(\s*\{([\s\S]{0,4000}?)\}\s*\)/g)) {
    const body = match[1] ?? "";
    const commandMatch = /(?:^|[,\s])cmd\s*:\s*("(?:\\.|[^"\\])*")/.exec(body);
    if (!commandMatch) continue;
    try {
      const command = JSON.parse(commandMatch[1]!) as string;
      const cwdMatch = /(?:^|[,\s])workdir\s*:\s*("(?:\\.|[^"\\])*")/.exec(body);
      commands.push({ command, ...(cwdMatch ? { cwd: JSON.parse(cwdMatch[1]!) as string } : {}) });
    } catch { /* dynamic literal remains unresolved below */ }
  }
  return commands;
}

export async function scanFile(
  file: SessionFile,
  request: AnalysisRequest,
  inventory: ResolvedInventory,
  onBytes?: (delta: number) => void,
): Promise<FileResult> {
  const collectRequests = request.includeRequested ?? true;
  const session: ScannedSession = {
    sessionKey: basename(file.path),
    loads: [],
    requests: [],
    unreadableRecords: 0,
    unresolvedLoadCandidates: 0,
    unresolvedRequestCandidates: 0,
  };
  let cwd: string | undefined;
  let contextOrdinal = 0;
  let taskOrdinal = 0;
  let userOrdinal = 0;
  const contextKeys = new Map<number, string>();
  const sessionAliases = new Map<string, ScannedSession["loads"][number]["skill"]>();
  let primarySessionMetaSeen = false;
  let sessionSkillSource: Record<string, unknown> | undefined;
  let sessionAliasesLoaded = false;
  const ensureSessionAliases = () => {
    if (sessionAliasesLoaded) return;
    sessionAliasesLoaded = true;
    if (!sessionSkillSource) return;
    for (const entry of sessionSkillEntries(sessionSkillSource)) sessionAliases.set(normalize(resolve(entry.path)), {
      id: skillId("codex", entry.name), name: entry.name,
    });
  };
  type Boundary = { context: number; task: number; user: number };
  type Candidate = {
    skill: ScannedSession["loads"][number]["skill"];
    occurredAt: string;
    explicitTurn?: string;
    boundary: Boundary;
    callId?: string;
    recordOrdinal: number;
  };
  type Pending = { commands: Array<{ command: string; cwd?: string }>; explicitTurn?: string; occurredAt?: string; boundary: Boundary; recordOrdinal: number };
  type RequestCandidate = { token: string; occurredAt: string; turnKey: string; fingerprint: string; messageOrdinal: number; recordOrdinal: number };
  const candidates: Candidate[] = [];
  const requestCandidates: RequestCandidate[] = [];
  const currentBoundary = (): Boundary => ({ context: contextOrdinal, task: taskOrdinal, user: userOrdinal });
  const qualityInRange = (timestamp: string | undefined) => {
    if (!timestamp) return true;
    const value = Date.parse(timestamp);
    if (Number.isNaN(value)) return true;
    return request.range.kind === "all"
      ? value <= Date.parse(request.range.asOf)
      : value >= Date.parse(request.range.from) && value < Date.parse(request.range.untilExclusive);
  };
  const pending = new Map<string, Pending>();
  const collect = (
    commandText: string,
    success: boolean | undefined,
    timestamp: string | undefined,
    commandCwd?: string,
    explicitTurn?: string,
    boundary = currentBoundary(),
    callId?: string,
    returnedNames = new Set<string>(),
    recordOrdinal = 0,
  ) => {
    const classification = classifyReadCommand(commandText);
    if (classification.kind === "unknown") {
      if (qualityInRange(timestamp)) session.unresolvedLoadCandidates += 1;
      return;
    }
    if (classification.kind !== "reads") return;
    if (classification.hasUnknownRelevant && qualityInRange(timestamp)) session.unresolvedLoadCandidates += 1;
    if (success === false) return;
    if (!timestamp) {
      session.unresolvedLoadCandidates += 1;
      return;
    }
    for (const path of classification.paths) {
      const entry = normalize(resolve(commandCwd ?? cwd ?? "/", path));
      let skill = sessionAliases.get(entry) ?? resolveSkill(path, commandCwd ?? cwd, inventory);
      if (!skill) {
        ensureSessionAliases();
        skill = sessionAliases.get(entry);
      }
      if (!skill) continue;
      const identified = returnedNames.has(skill.name.normalize("NFKC").toLocaleLowerCase("en-US"));
      const successProven = classification.successProvenPaths.includes(path);
      if ((success === undefined || (success === true && !successProven)) && !identified) {
        if (qualityInRange(timestamp)) session.unresolvedLoadCandidates += 1;
        continue;
      }
      candidates.push({ skill, explicitTurn, boundary, callId, recordOrdinal, occurredAt: new Date(timestamp).toISOString() });
    }
  };
  try {
    let recordOrdinal = 0;
    for await (const line of lines(file.path, MAX_RECORD_BYTES, file.sizeBytes, onBytes)) {
      recordOrdinal += 1;
      if (!line.text) {
        if (line.relevant) session.unreadableRecords += 1;
        continue;
      }
      let root: Record<string, unknown>;
      try {
        root = JSON.parse(line.text) as Record<string, unknown>;
      } catch {
        session.unreadableRecords += 1;
        continue;
      }
      const payload = asObject(root.payload);
      if (root.type === "session_meta" || payload?.type === "session_meta") {
        const meta = payload ?? root;
        if (!primarySessionMetaSeen) {
          primarySessionMetaSeen = true;
          session.sessionKey = textAt(meta, "id") ?? session.sessionKey;
          session.parentSessionKey = metaParentSessionKey(meta);
          session.isSubagent = metaIsSubagent(meta);
          cwd = textAt(meta, "cwd") ?? cwd;
          sessionSkillSource = meta;
        } else if (textAt(meta, "id") && textAt(meta, "id") !== session.sessionKey) {
          session.metadataConflict = true;
        }
      }
      const context = root.type === "turn_context" ? root : payload?.type === "turn_context" ? payload : undefined;
      if (context) {
        contextOrdinal += 1;
        contextKeys.set(contextOrdinal, textAt(context, "turn_id") ?? textAt(payload ?? {}, "turn_id") ?? `turn-context-${contextOrdinal}`);
      }
      const recordType = typeof root.type === "string" ? root.type : textAt(payload ?? {}, "type");
      if (recordType === "task_started") taskOrdinal += 1;
      if (["user_message", "userMessage"].includes(recordType ?? "")) userOrdinal += 1;
      if (root.type === "response_item" && payload?.type === "message" && payload.role === "user") {
        const text = messageText(payload);
        const timestamp = textAt(root, "timestamp");
        userOrdinal += 1;
        if (!collectRequests || !text || isGeneratedUserMessage(text)) continue;
        if (!timestamp || Number.isNaN(Date.parse(timestamp))) {
          if (text.includes("$")) session.unresolvedRequestCandidates += 1;
        } else {
          const tokens = text.includes("$") ? requestTokens(text) : [];
          if (tokens.length === 0) continue;
          const fingerprint = requestFingerprint(text);
          for (const token of tokens) {
            requestCandidates.push({ token, occurredAt: new Date(timestamp).toISOString(), turnKey: `user-message-${userOrdinal}`, fingerprint, messageOrdinal: userOrdinal, recordOrdinal });
          }
        }
      }
      for (const command of nestedCommandExecutions(root)) {
        const timestamp = textAt(root, "timestamp") ?? textAt(payload ?? {}, "timestamp");
        const explicitTurn = textAt(command, "turn_id") ?? textAt(root, "turn_id") ?? textAt(payload ?? {}, "turn_id");
        const parsed = Array.isArray(command.parsed_cmd)
          ? command.parsed_cmd.flatMap((item) => {
            const operation = asObject(item);
            return operation?.type === "read" && typeof operation.cmd === "string" ? [operation.cmd] : [];
          })
          : [];
        const commands = parsed.length > 0
          ? parsed
          : [textAt(command, "command") ?? textAt(command, "parsed_cmd")].filter((item): item is string => Boolean(item));
        for (const commandText of commands) collect(
          commandText,
          command.status === "completed" && command.exit_code === 0
            ? true
            : command.status === "completed" || command.status === "failed" ? false : undefined,
          timestamp,
          textAt(command, "cwd"),
          explicitTurn,
          currentBoundary(),
          textAt(command, "call_id") ?? textAt(command, "id"),
          new Set(),
          recordOrdinal,
        );
      }
      const type = textAt(payload ?? {}, "type");
      if (root.type === "response_item" && type === "function_call" && textAt(payload ?? {}, "name") === "exec_command") {
        const callId = textAt(payload ?? {}, "call_id");
        const argumentsText = textAt(payload ?? {}, "arguments");
        if (callId && argumentsText) {
          try {
            const argumentsObject = JSON.parse(argumentsText) as Record<string, unknown>;
            const command = typeof argumentsObject.cmd === "string" ? argumentsObject.cmd : typeof argumentsObject.command === "string" ? argumentsObject.command : undefined;
            if (command && classifyReadCommand(command).kind !== "negative") {
              if (pending.size >= 256) {
                const oldest = pending.entries().next().value as [string, Pending] | undefined;
                if (oldest) {
                  pending.delete(oldest[0]);
                  for (const item of oldest[1].commands) collect(item.command, undefined, oldest[1].occurredAt, item.cwd, oldest[1].explicitTurn, oldest[1].boundary, oldest[0], new Set(), oldest[1].recordOrdinal);
                }
              }
              pending.set(callId, {
                commands: [{ command, cwd }],
                explicitTurn: textAt(root, "turn_id") ?? textAt(payload ?? {}, "turn_id"),
                occurredAt: textAt(root, "timestamp"),
                boundary: currentBoundary(),
                recordOrdinal,
              });
            }
          } catch {
            if (argumentsText.includes("SKILL.md") && qualityInRange(textAt(root, "timestamp"))) session.unresolvedLoadCandidates += 1;
          }
        }
      }
      if (root.type === "response_item" && type === "custom_tool_call" && textAt(payload ?? {}, "name") === "exec") {
        const callId = textAt(payload ?? {}, "call_id");
        const input = textAt(payload ?? {}, "input");
        const commands = input?.includes("SKILL.md") ? customExecCommands(input) : [];
        if (callId && commands.length > 0) {
          if (pending.size >= 256) {
            const oldest = pending.entries().next().value as [string, Pending] | undefined;
            if (oldest) {
              pending.delete(oldest[0]);
              for (const item of oldest[1].commands) collect(item.command, undefined, oldest[1].occurredAt, item.cwd, oldest[1].explicitTurn, oldest[1].boundary, oldest[0], new Set(), oldest[1].recordOrdinal);
            }
          }
          pending.set(callId, {
            commands,
            explicitTurn: textAt(root, "turn_id") ?? textAt(payload ?? {}, "turn_id"),
            occurredAt: textAt(root, "timestamp"),
            boundary: currentBoundary(),
            recordOrdinal,
          });
        } else if (input?.includes("SKILL.md") && qualityInRange(textAt(root, "timestamp"))) {
          session.unresolvedLoadCandidates += 1;
        }
      }
      if (root.type === "response_item" && type === "function_call_output") {
        const callId = textAt(payload ?? {}, "call_id");
        const call = callId ? pending.get(callId) : undefined;
        if (call) {
          pending.delete(callId!);
          const output = outputText(payload ?? {});
          let success: boolean | undefined;
          try {
            const outputObject = JSON.parse(output) as Record<string, unknown>;
            success = outputObject.exit_code === 0 ? true : typeof outputObject.exit_code === "number" ? false : undefined;
          } catch {
            success = /Process exited with code 0\b/.test(output) ? true : undefined;
          }
          for (const item of call.commands) collect(item.command, success, textAt(root, "timestamp") ?? call.occurredAt, item.cwd, call.explicitTurn, call.boundary, callId, outputSkillNames(output), call.recordOrdinal);
        }
      }
      if (root.type === "response_item" && type === "custom_tool_call_output") {
        const callId = textAt(payload ?? {}, "call_id");
        const call = callId ? pending.get(callId) : undefined;
        if (call) {
          pending.delete(callId!);
          const output = outputText(payload ?? {});
          const structuredExit = /["']?exit_code["']?\s*[:=]\s*([0-9]+)/.exec(output)?.[1];
          const success = structuredExit === "0" ? true : structuredExit ? false : undefined;
          for (const item of call.commands) collect(item.command, success, textAt(root, "timestamp") ?? call.occurredAt, item.cwd, call.explicitTurn, call.boundary, callId, outputSkillNames(output), call.recordOrdinal);
        }
      }
    }
    for (const [callId, call] of pending) for (const item of call.commands) collect(item.command, undefined, call.occurredAt, item.cwd, call.explicitTurn, call.boundary, callId, new Set(), call.recordOrdinal);
    if (collectRequests && !session.isSubagent && !session.metadataConflict) {
      ensureSessionAliases();
      const requestSkills = new Map<string, ScannedSession["requests"][number]["skill"]>();
      for (const skill of inventory.result.skills) requestSkills.set(skill.name.normalize("NFKC").toLocaleLowerCase("en-US"), skill);
      for (const skill of sessionAliases.values()) requestSkills.set(skill.name.normalize("NFKC").toLocaleLowerCase("en-US"), skill);
      for (const candidate of requestCandidates) {
        const skill = requestSkills.get(candidate.token);
        if (!skill) {
          session.unresolvedRequestCandidates += 1;
          continue;
        }
        session.requests.push({
          skill,
          occurredAt: candidate.occurredAt,
          turnKey: candidate.turnKey,
          messageFingerprint: candidate.fingerprint,
          messageOrdinal: candidate.messageOrdinal,
          sourceOrdinal: file.ordinal,
          recordOrdinal: candidate.recordOrdinal,
        });
      }
    } else if (collectRequests && session.metadataConflict) {
      session.unresolvedRequestCandidates += requestCandidates.length;
    }
    const useExplicit = candidates.some((candidate) => Boolean(candidate.explicitTurn));
    for (const candidate of candidates) {
      const [turnKey, turnEvidence] = useExplicit
        ? [candidate.explicitTurn, "explicit" as const]
        : contextOrdinal > 0
          ? candidate.boundary.context > 0 ? [contextKeys.get(candidate.boundary.context), "context" as const] : [undefined, undefined]
          : taskOrdinal > 0
            ? candidate.boundary.task > 0 ? [`task-started-${candidate.boundary.task}`, "task" as const] : [undefined, undefined]
            : userOrdinal > 0 && candidate.boundary.user > 0
              ? [`user-message-${candidate.boundary.user}`, "user" as const]
              : [undefined, undefined];
      if (!turnKey) {
        if (qualityInRange(candidate.occurredAt)) session.unresolvedLoadCandidates += 1;
        continue;
      }
      session.loads.push({ skill: candidate.skill, occurredAt: candidate.occurredAt, turnKey, callId: candidate.callId, turnEvidence, sourceOrdinal: file.ordinal, recordOrdinal: candidate.recordOrdinal });
    }
    let projectRoots: Array<[string, string]> = [];
    if (cwd && request.projectSelector) {
      const project = await projectFromCwd(cwd);
      session.project = project.ref;
      projectRoots = [[project.ref.id, project.root]];
    }
    const current = await stat(file.path);
    if (current.size < file.sizeBytes || (current.size === file.sizeBytes && current.mtimeMs !== file.mtimeMs)) {
      session.unreadableRecords += 1;
    }
    return { ordinal: file.ordinal, sessions: [session], bytesScanned: file.sizeBytes, unreadableRecords: session.unreadableRecords, projectRoots };
  } catch {
    return { ordinal: file.ordinal, sessions: [], bytesScanned: 0, unreadableRecords: 1, projectRoots: [] };
  }
}

export class CodexSkillScanner implements PlatformSkillScanner {
  constructor(private readonly options: { historyHome?: string } = {}) {}

  async scan(
    request: AnalysisRequest,
    onProgress?: (snapshot: ProgressSnapshot) => void,
  ): Promise<PlatformScanResult> {
    const collectRequests = request.includeRequested ?? true;
    const historyHome = this.options.historyHome ?? request.codexHome;
    let files = await discover(historyHome, request);
    files = await expandLineageParents(files, historyHome);
    let inventory = await resolveInventory(request.codexHome);
    const totalBytes = files.reduce((sum, file) => sum + file.sizeBytes, 0);
    const started = Date.now();
    const results: FileResult[] = [];
    let processedBytes = 0;
    let completedFiles = 0;
    let nextFile = 0;
    const workers = Math.min(request.jobs, Math.max(1, files.length));
    const failedResult = (file: SessionFile): FileResult => ({
      ordinal: file.ordinal,
      sessions: [],
      bytesScanned: 0,
      unreadableRecords: 1,
      projectRoots: [],
    });
    const createWorker = () => new Worker(new URL("./worker.js", import.meta.url), {
      resourceLimits: {
        maxOldGenerationSizeMb: 128,
        maxYoungGenerationSizeMb: 32,
      },
      workerData: {
        reportProgress: Boolean(onProgress),
        request,
        inventory: {
          result: inventory.result,
          aliases: [...inventory.aliases.entries()],
          acceptedRoots: inventory.acceptedRoots,
        },
      },
    });
    const scanOne = async (worker: Worker, file: SessionFile, onBytes: (delta: number) => void): Promise<{ result: FileResult; reusable: boolean }> => {
      return new Promise((resolveResult) => {
        let settled = false;
        const finish = (result: FileResult, reusable: boolean) => {
          if (settled) return;
          settled = true;
          worker.off("message", handleMessage);
          worker.off("error", handleError);
          worker.off("exit", handleExit);
          resolveResult({ result, reusable });
        };
        const handleMessage = (message: { kind: "progress"; bytes: number } | { kind: "result"; result: FileResult }) => {
          if (message.kind === "progress") onBytes(message.bytes);
          else finish(message.result, true);
        };
        const handleError = () => finish(failedResult(file), false);
        const handleExit = () => finish(failedResult(file), false);
        worker.on("message", handleMessage);
        worker.once("error", handleError);
        worker.once("exit", handleExit);
        try {
          worker.postMessage({ kind: "scan", file });
        } catch {
          finish(failedResult(file), false);
        }
      });
    };
    await Promise.all(Array.from({ length: workers }, async () => {
      let worker = import.meta.url.endsWith(".ts") ? undefined : createWorker();
      try {
        for (;;) {
          const file = files[nextFile];
          nextFile += 1;
          if (!file) return;
          let fileBytes = 0;
          const reportBytes = (delta: number) => {
            fileBytes += delta;
            processedBytes = Math.min(totalBytes, processedBytes + delta);
            onProgress?.({ completedFiles, totalFiles: files.length, processedBytes, totalBytes, elapsedMs: Date.now() - started });
          };
          const outcome = worker
            ? await scanOne(worker, file, reportBytes)
            : { result: await scanFile(file, request, inventory, reportBytes), reusable: true };
          results.push(outcome.result);
          processedBytes = Math.min(totalBytes, processedBytes + Math.max(0, outcome.result.bytesScanned - fileBytes));
          completedFiles += 1;
          onProgress?.({ completedFiles, totalFiles: files.length, processedBytes, totalBytes, elapsedMs: Date.now() - started });
          if (worker && !outcome.reusable) {
            await worker.terminate();
            worker = createWorker();
          }
        }
      } finally {
        if (worker) await worker.terminate();
      }
    }));
    results.sort((left, right) => left.ordinal - right.ordinal);
    if (files.length > 0 && results.every((result) => result.sessions.length === 0 && result.unreadableRecords > 0)) {
      throw new Error("all workers failed");
    }
    const merged = new Map<string, ScannedSession>();
    for (const session of results.flatMap((result) => result.sessions)) {
      const existing = merged.get(session.sessionKey);
      if (!existing) {
        merged.set(session.sessionKey, { ...session, loads: [...session.loads], requests: [...session.requests] });
        continue;
      }
      existing.loads.push(...session.loads);
      existing.requests.push(...session.requests);
      existing.unreadableRecords += session.unreadableRecords;
      existing.unresolvedLoadCandidates += session.unresolvedLoadCandidates;
      existing.unresolvedRequestCandidates += session.unresolvedRequestCandidates;
      if (existing.project?.id !== session.project?.id) {
        existing.project = undefined;
        existing.unreadableRecords += 1;
      }
    }
    const canonicalCalls = new Map<string, { sessionKey: string; sourceOrdinal: number; recordOrdinal: number; occurredAt: string }>();
    for (const session of merged.values()) for (const load of session.loads) {
      if (!load.callId) continue;
      const candidate = { sessionKey: session.sessionKey, sourceOrdinal: load.sourceOrdinal ?? Number.MAX_SAFE_INTEGER, recordOrdinal: load.recordOrdinal ?? Number.MAX_SAFE_INTEGER, occurredAt: load.occurredAt };
      const existing = canonicalCalls.get(load.callId);
      if (!existing || [candidate.occurredAt, candidate.sourceOrdinal, candidate.recordOrdinal].join("\0") < [existing.occurredAt, existing.sourceOrdinal, existing.recordOrdinal].join("\0")) canonicalCalls.set(load.callId, candidate);
    }
    for (const session of merged.values()) {
      session.loads = session.loads.filter((load) => {
        if (!load.callId) return true;
        const canonical = canonicalCalls.get(load.callId);
        return canonical?.sessionKey === session.sessionKey && canonical.sourceOrdinal === load.sourceOrdinal && canonical.recordOrdinal === load.recordOrdinal;
      });
    }
    for (const session of merged.values()) {
      if (!session.parentSessionKey) continue;
      const inheritedWithoutCallId = session.loads.filter((load) => !load.callId);
      const parent = merged.get(session.parentSessionKey);
      if (!parent) {
        session.unresolvedLoadCandidates += inheritedWithoutCallId.length;
        session.loads = session.loads.filter((load) => load.callId);
        continue;
      }
      const parentLoads = new Set(parent.loads
        .filter((load) => !load.callId && (load.turnEvidence === "explicit" || load.turnEvidence === "context"))
        .map((load) => `${load.skill.id}\u0000${load.turnKey}`));
      session.loads = session.loads.filter((load) => {
        if (load.callId) return true;
        if (load.turnEvidence !== "explicit" && load.turnEvidence !== "context") {
          session.unresolvedLoadCandidates += 1;
          return true;
        }
        return !parentLoads.has(`${load.skill.id}\u0000${load.turnKey}`);
      });
    }
    let requestUnreadableRecords = collectRequests ? results.reduce((sum, result) => sum + result.unreadableRecords, 0) : 0;
    if (collectRequests) try {
      const history = await readFile(join(historyHome, "history.jsonl"), "utf8");
      const skillsByName = new Map(inventory.result.skills.map((skill) => [skill.name.normalize("NFKC").toLocaleLowerCase("en-US"), skill]));
      const sourceOrdinal = files.length;
      let recordOrdinal = 0;
      for (const line of history.split("\n")) {
        if (!line) continue;
        recordOrdinal += 1;
        try {
          const item = JSON.parse(line) as Record<string, unknown>;
          const sessionKey = textAt(item, "session_id");
          const timestamp = textAt(item, "ts");
          const text = textAt(item, "text");
          if (!sessionKey || !timestamp || !text || Number.isNaN(Date.parse(timestamp))) continue;
          const session = merged.get(sessionKey) ?? {
            sessionKey,
            loads: [],
            requests: [],
            unreadableRecords: 0,
            unresolvedLoadCandidates: 0,
            unresolvedRequestCandidates: 0,
          };
          if (session.isSubagent) continue;
          const tokens = text.includes("$") ? requestTokens(text) : [];
          if (tokens.length === 0) continue;
          const fingerprint = requestFingerprint(text);
          for (const token of tokens) {
            const skill = skillsByName.get(token);
            if (!skill) {
              session.unresolvedRequestCandidates += 1;
              continue;
            }
            session.requests.push({ skill, occurredAt: new Date(timestamp).toISOString(), turnKey: `history-${recordOrdinal}`, messageFingerprint: fingerprint, sourceOrdinal, recordOrdinal });
          }
          merged.set(sessionKey, session);
        } catch {
          requestUnreadableRecords += 1;
        }
      }
    } catch {
      // history.jsonl is optional; its absence is not a coverage failure.
    }
    if (collectRequests) for (const session of merged.values()) {
      const grouped = new Map<string, Map<number, typeof session.requests>>();
      for (const item of session.requests) {
        const key = `${item.skill.id}\u0000${item.occurredAt}\u0000${item.messageFingerprint ?? item.turnKey}`;
        const sources = grouped.get(key) ?? new Map<number, typeof session.requests>();
        const source = item.sourceOrdinal ?? Number.MAX_SAFE_INTEGER;
        const events = sources.get(source) ?? [];
        events.push(item);
        sources.set(source, events);
        grouped.set(key, sources);
      }
      session.requests = [...grouped.values()].flatMap((sources) => {
        const count = Math.max(...[...sources.values()].map((events) => events.length));
        return [...sources.values()].flat().sort((left, right) =>
          (left.sourceOrdinal ?? Number.MAX_SAFE_INTEGER) - (right.sourceOrdinal ?? Number.MAX_SAFE_INTEGER) ||
          (left.recordOrdinal ?? Number.MAX_SAFE_INTEGER) - (right.recordOrdinal ?? Number.MAX_SAFE_INTEGER),
        ).slice(0, count);
      });
    }
    if (collectRequests) for (const session of merged.values()) {
      if (!session.parentSessionKey || session.isSubagent) continue;
      const parent = merged.get(session.parentSessionKey);
      if (!parent) {
        const rolloutCandidates = session.requests.filter((item) => item.messageOrdinal !== undefined);
        session.unresolvedRequestCandidates += rolloutCandidates.length;
        session.requests = session.requests.filter((item) => item.messageOrdinal === undefined);
        continue;
      }
      const inherited = new Set(parent.requests
        .filter((item) => item.messageOrdinal !== undefined && item.messageFingerprint)
        .map((item) => `${item.skill.id}\u0000${item.messageOrdinal}\u0000${item.messageFingerprint}`));
      session.requests = session.requests.filter((item) =>
        item.messageOrdinal === undefined || !item.messageFingerprint ||
        !inherited.has(`${item.skill.id}\u0000${item.messageOrdinal}\u0000${item.messageFingerprint}`),
      );
    }
    const sessions = [...merged.values()];
    const projects = new Map(
      sessions.flatMap((session) => session.project ? [[session.project.id, session.project] as const] : []),
    );
    let project: ProjectRef | undefined;
    const selector = request.projectSelector;
    if (selector) {
      const matches = [...projects.values()].filter((candidate) =>
        candidate.id === selector ||
        candidate.id.startsWith(selector) ||
        candidate.name === selector,
      );
      if (matches.length !== 1) throw new Error(
        matches.length === 0 ? "project not found" : `project is ambiguous: ${matches.map((item) => `${item.name} ${item.id.slice(0, 8)}`).join(", ")}`,
      );
      project = matches[0];
      const projectRoot = results.flatMap((result) => result.projectRoots)
        .find(([id]) => id === project?.id)?.[1];
      if (projectRoot) inventory = await resolveInventory(request.codexHome, projectRoot);
    }
    return {
      platform: "codex",
      ...(project ? { project } : {}),
      sessions,
      inventory: inventory.result,
      sourceStats: {
        filesScanned: completedFiles,
        bytesScanned: processedBytes,
        unreadableRecords: results.reduce((sum, result) => sum + result.unreadableRecords, 0),
        requestUnreadableRecords,
      },
    };
  }
}
