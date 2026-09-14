import type { SkillUsageReportV1 } from "../core/types.js";
import { assertSafeOutput } from "../core/safety.js";

export interface TerminalRenderOptions {
  isTTY?: boolean;
  columns?: number;
  requested?: boolean;
  limit?: number;
  showZero?: boolean;
  ascii?: boolean;
  now?: Date;
}

type RankedSkill = { id: string; name: string; count: number; sessions: number; last: string; daily: Array<{ date: string; count: number }> };

function localDate(instant: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(instant));
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return values.year + "-" + values.month + "-" + values.day;
}

function pad(value: string, width: number): string {
  return value + " ".repeat(Math.max(0, width - value.length));
}

function left(value: string | number, width: number): string {
  const text = String(value);
  return " ".repeat(Math.max(0, width - text.length)) + text;
}

function buckets(values: number[], limit = 12): number[] {
  const length = Math.min(values.length, limit);
  if (length === 0) return [];
  const result = Array.from({ length }, () => [] as number[]);
  values.forEach((value, index) => result[Math.floor(index * length / values.length)]!.push(value));
  return result.map((bucket) => bucket.reduce((sum, value) => sum + value, 0) / bucket.length);
}

function sparkline(values: number[], ascii: boolean): string {
  const bars = ascii ? ".:-=+*#@" : "▁▂▃▄▅▆▇█";
  const zero = ascii ? "." : "·";
  const max = Math.max(0, ...values);
  if (max === 0) return zero.repeat(values.length);
  return values.map((value) => value === 0 ? zero : bars[Math.max(0, Math.ceil(value / max * bars.length) - 1)]!).join("");
}

function seriesForRange(report: SkillUsageReportV1, values: Array<{ date: string; count: number }>): number[] {
  const byDate = new Map(values.map((item) => [item.date, item.count]));
  return report.activity.map((item) => byDate.get(item.date) ?? 0);
}

function overallSeries(report: SkillUsageReportV1, requested: boolean): number[] {
  return report.activity.map((item) => requested ? item.requests : item.loads);
}

function trendValues(report: SkillUsageReportV1, values: number[]): number[] {
  return buckets(values);
}

function trendScope(report: SkillUsageReportV1, pointCount: number): string {
  const days = report.activity.length;
  if (report.query.range.kind !== "all" || days === 0 || pointCount === 0) return days + " days";
  return days + " days · ≈" + Math.round(days / pointCount) + "d/bucket";
}

function sevenDayComparison(report: SkillUsageReportV1, requested: boolean, now: Date): string | undefined {
  let entries = report.activity;
  const today = localDate(now.toISOString(), report.query.timezone);
  if (entries.at(-1)?.date === today) entries = entries.slice(0, -1);
  if (entries.length < 14) return undefined;
  const current = entries.slice(-7).reduce((sum, item) => sum + (requested ? item.requests : item.loads), 0);
  const previous = entries.slice(-14, -7).reduce((sum, item) => sum + (requested ? item.requests : item.loads), 0);
  return "Last 7 complete days: " + previous + " → " + current + " (" + (current - previous >= 0 ? "+" : "") + (current - previous) + ") · " + entries.at(-14)!.date.slice(5) + "–" + entries.at(-8)!.date.slice(5) + " → " + entries.at(-7)!.date.slice(5) + "–" + entries.at(-1)!.date.slice(5);
}

function nameMap(report: SkillUsageReportV1): Map<string, number> {
  const ids = new Map<string, Set<string>>();
  for (const skill of [...report.skills, ...report.zero_load_skills, ...report.requested_skills]) {
    const values = ids.get(skill.name) ?? new Set<string>();
    values.add(skill.id);
    ids.set(skill.name, values);
  }
  return new Map([...ids].map(([name, values]) => [name, values.size]));
}

function displayName(skill: { name: string; id: string }, names: Map<string, number>): string {
  return (names.get(skill.name) ?? 0) > 1 ? skill.name + " [" + skill.id.slice(0, 8) + "]" : skill.name;
}

function renderColumns(items: string[], columns: number, maximum = 3): string[] {
  if (items.length === 0) return ["None."];
  const width = Math.max(...items.map((item) => item.length));
  const count = Math.max(1, Math.min(maximum, items.length, Math.floor((columns + 2) / (width + 2))));
  if (count === 1) return items;
  const rows = Math.ceil(items.length / count);
  return Array.from({ length: rows }, (_, row) => {
    const cells = Array.from({ length: count }, (_, column) => items[row + column * rows]).filter((item): item is string => item !== undefined);
    return cells.map((item, index) => index === cells.length - 1 ? item : pad(item, width)).join("  ");
  });
}

export function renderTerminal(report: SkillUsageReportV1, options: TerminalRenderOptions = {}): string {
  const requested = options.requested ?? false;
  const limit = options.limit ?? 0;
  const showZero = options.showZero ?? false;
  const isTTY = options.isTTY ?? false;
  const columns = Math.max(40, options.columns ?? 80);
  const narrow = isTTY && columns < 60;
  const range = report.query.range.kind === "all"
    ? "All history · as of " + localDate(report.query.range.as_of, report.query.timezone)
    : report.query.range.from + " – " + report.query.range.until;
  const project = report.query.project ? "Project " + report.query.project.name : "All projects";
  const names = nameMap(report);
  const ranked: RankedSkill[] = requested
    ? report.requested_skills.map((item) => ({ id: item.id, name: item.name, count: item.requests, sessions: item.sessions, last: item.last_requested_at, daily: item.daily_requests }))
    : report.skills.map((item) => ({ id: item.id, name: item.name, count: item.loads, sessions: item.sessions, last: item.last_detected_at, daily: item.daily_loads }));
  const displayed = limit === 0 ? ranked : ranked.slice(0, limit);
  const heading = requested ? "Requested" : "Loaded";
  const plural = requested ? "requests" : "loads";
  const uniqueSessions = requested ? report.summary.sessions_with_requests : report.summary.sessions_with_loads;
  const total = requested ? report.summary.requests : report.summary.loads;
  const overallTrend = trendValues(report, overallSeries(report, requested));
  const lines = [
    "skillusage · " + report.query.platform + " · " + heading,
    ...(narrow ? [range, project] : [range + " · " + project]),
    total + " " + plural + " · " + uniqueSessions + " sessions · " + ranked.length + " skills with " + (requested ? "requests" : "loads"),
    "Trend " + sparkline(overallTrend, Boolean(options.ascii)) + " · " + trendScope(report, overallTrend.length),
  ];
  const comparison = sevenDayComparison(report, requested, options.now ?? new Date());
  if (comparison) lines.push(comparison);
  lines.push("");
  if (ranked.length === 0) {
    lines.push(requested ? "No explicit $skill request detected in selected range." : "No Skill Load detected in selected range.");
  } else if (narrow) {
    displayed.forEach((skill, index) => {
      lines.push((index + 1) + ". " + displayName(skill, names));
      lines.push("   " + skill.count + " " + plural + " · " + skill.sessions + " sessions · " + localDate(skill.last, report.query.timezone));
      lines.push("   Trend " + sparkline(trendValues(report, seriesForRange(report, skill.daily)), Boolean(options.ascii)));
    });
  } else {
    const rendered = displayed.map((skill) => ({ ...skill, name: displayName(skill, names), date: localDate(skill.last, report.query.timezone), trend: sparkline(trendValues(report, seriesForRange(report, skill.daily)), Boolean(options.ascii)) }));
    const rankWidth = String(Math.max(1, displayed.length)).length;
    const countLabel = requested ? "Requests" : "Loads";
    const countWidth = Math.max(countLabel.length, ...rendered.map((skill) => String(skill.count).length));
    const sessionWidth = Math.max(4, ...rendered.map((skill) => String(skill.sessions).length));
    const fullNameWidth = Math.max("Skill".length, ...rendered.map((skill) => skill.name.length));
    const singleLineWidth = rankWidth + 2 + fullNameWidth + 2 + countWidth + 2 + sessionWidth + 2 + 10 + 2 + 12;
    const wide = singleLineWidth <= columns;
    if (wide) {
      lines.push(left("#", rankWidth) + "  " + pad("Skill", fullNameWidth) + "  " + left(countLabel, countWidth) + "  " + left("Sess", sessionWidth) + "  Last date   Trend");
      rendered.forEach((skill, index) => {
        lines.push(left(index + 1, rankWidth) + "  " + pad(skill.name, fullNameWidth) + "  " + left(skill.count, countWidth) + "  " + left(skill.sessions, sessionWidth) + "  " + skill.date + "  " + skill.trend);
      });
    } else {
      const fixedWidth = rankWidth + 2 + 2 + countWidth + 2 + sessionWidth + 2 + 10;
      const nameWidth = Math.max(12, Math.min(fullNameWidth, columns - fixedWidth));
      lines.push(left("#", rankWidth) + "  " + pad("Skill", nameWidth) + "  " + left(countLabel, countWidth) + "  " + left("Sess", sessionWidth) + "  Last date");
      rendered.forEach((skill, index) => {
        if (skill.name.length > nameWidth) {
          lines.push(left(index + 1, rankWidth) + "  " + skill.name);
          lines.push(" ".repeat(rankWidth + 2 + nameWidth + 2) + left(skill.count, countWidth) + "  " + left(skill.sessions, sessionWidth) + "  " + skill.date);
        } else {
          lines.push(left(index + 1, rankWidth) + "  " + pad(skill.name, nameWidth) + "  " + left(skill.count, countWidth) + "  " + left(skill.sessions, sessionWidth) + "  " + skill.date);
        }
        lines.push(" ".repeat(rankWidth + 2) + "Trend " + skill.trend);
      });
    }
  }
  if (ranked.length > displayed.length) lines.push((ranked.length - displayed.length) + " more: skillusage" + (requested ? " --requested" : "") + " --limit 0");
  lines.push("");
  if (!requested) {
    if (report.coverage.inventory_status === "unavailable") lines.push("Current Skill inventory unavailable.");
    else if (showZero) {
      lines.push("Not loaded in this range · " + report.zero_load_skills.length);
      const zeroNames = report.zero_load_skills.map((skill) => displayName(skill, names));
      lines.push(...(isTTY ? renderColumns(zeroNames, columns) : zeroNames.length > 0 ? zeroNames : ["None."]));
      lines.push("");
    } else lines.push(report.zero_load_skills.length + " current skills: no load detected in range · --show-zero");
  }
  lines.push("Trend: daily average / bucket; each row scaled independently.");
  if (!requested) lines.push("Explicit requests: skillusage --requested");
  const output = lines.join("\n") + "\n";
  assertSafeOutput(output);
  return output;
}
