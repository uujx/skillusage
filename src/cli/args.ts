import { homedir } from "node:os";
import { join } from "node:path";

import type { AnalysisRequest } from "../core/types.js";

export interface CliOptions {
  request: AnalysisRequest;
  json: boolean;
  help: boolean;
  version: boolean;
}

function dateParts(instant: Date, timezone: string): { year: number; month: number; day: number } {
  const values = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(instant).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]),
  );
  return { year: Number(values.year), month: Number(values.month), day: Number(values.day) };
}

function parseDate(value: string): { year: number; month: number; day: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new Error("date must be YYYY-MM-DD");
  const result = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  const normalized = new Date(Date.UTC(result.year, result.month - 1, result.day));
  if (
    normalized.getUTCFullYear() !== result.year ||
    normalized.getUTCMonth() !== result.month - 1 ||
    normalized.getUTCDate() !== result.day
  ) {
    throw new Error("invalid date");
  }
  return result;
}

function zonedMidnight(parts: { year: number; month: number; day: number }, timezone: string): string {
  let guess = Date.UTC(parts.year, parts.month - 1, parts.day);
  for (let index = 0; index < 3; index += 1) {
    const rendered = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(guess));
    const values = Object.fromEntries(rendered.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
    const representedAsUtc = Date.UTC(
      Number(values.year), Number(values.month) - 1, Number(values.day),
      Number(values.hour), Number(values.minute), Number(values.second),
    );
    const targetUtc = Date.UTC(parts.year, parts.month - 1, parts.day);
    const next = targetUtc - (representedAsUtc - guess);
    if (next === guess) break;
    guess = next;
  }
  return new Date(guess).toISOString();
}

function incrementDate(parts: { year: number; month: number; day: number }, days: number) {
  const value = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return { year: value.getUTCFullYear(), month: value.getUTCMonth() + 1, day: value.getUTCDate() };
}

function requireValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

export function parseCliArgs(args: string[], now = new Date()): CliOptions {
  let days: number | undefined;
  let from: string | undefined;
  let until: string | undefined;
  let all = false;
  let timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  let projectSelector: string | undefined;
  let codexHome = join(homedir(), ".codex");
  let jobs = 4 as 1 | 2 | 3 | 4;
  let json = false;
  let help = false;
  let version = false;

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    switch (flag) {
      case "--days": days = Number(requireValue(args, index, flag)); index += 1; break;
      case "--from": from = requireValue(args, index, flag); index += 1; break;
      case "--until": until = requireValue(args, index, flag); index += 1; break;
      case "--all": all = true; break;
      case "--timezone": timezone = requireValue(args, index, flag); index += 1; break;
      case "--project": projectSelector = requireValue(args, index, flag); index += 1; break;
      case "--codex-home": codexHome = requireValue(args, index, flag); index += 1; break;
      case "--jobs": jobs = Number(requireValue(args, index, flag)) as 1 | 2 | 3 | 4; index += 1; break;
      case "--json": json = true; break;
      case "--help": case "-h": help = true; break;
      case "--version": case "-v": version = true; break;
      default: throw new Error(`unknown option: ${flag}`);
    }
  }
  try { Intl.DateTimeFormat("en-US", { timeZone: timezone }); } catch { throw new Error("invalid IANA timezone"); }
  if (days !== undefined && (![7, 30, 90].includes(days) || !Number.isInteger(days))) {
    throw new Error("--days must be 7, 30, or 90");
  }
  if (jobs < 1 || jobs > 4 || !Number.isInteger(jobs)) throw new Error("--jobs must be 1 through 4");
  if (Number(Boolean(days)) + Number(Boolean(from || until)) + Number(all) > 1) throw new Error("date modes are mutually exclusive");
  if (Boolean(from) !== Boolean(until)) throw new Error("--from and --until must be used together");

  let range: AnalysisRequest["range"];
  if (all) range = { kind: "all", asOf: now.toISOString() };
  else {
    const end = until ? parseDate(until) : dateParts(now, timezone);
    const start = from ? parseDate(from) : incrementDate(end, -((days ?? 30) - 1));
    if (Date.UTC(start.year, start.month - 1, start.day) > Date.UTC(end.year, end.month - 1, end.day)) throw new Error("--from must not exceed --until");
    range = {
      kind: "bounded",
      from: zonedMidnight(start, timezone),
      untilExclusive: zonedMidnight(incrementDate(end, 1), timezone),
    };
  }
  return { request: { range, timezone, projectSelector, codexHome, jobs }, json, help, version };
}
