import type { SkillUsageReportV1 } from "../core/types.js";
import { assertSafeOutput } from "../core/safety.js";

export interface TerminalRenderOptions {
  isTTY?: boolean;
  columns?: number;
}

function localDate(instant: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(instant));
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function truncate(value: string, width: number): string {
  return value.length <= width ? value : `${value.slice(0, Math.max(1, width - 1))}…`;
}

function pad(value: string, width: number): string {
  return `${value}${" ".repeat(Math.max(0, width - value.length))}`;
}

function left(value: string | number, width: number): string {
  const text = String(value);
  return `${" ".repeat(Math.max(0, width - text.length))}${text}`;
}

function zeroGrid(names: string[], columns: number): string[] {
  if (names.length === 0) return ["None."];
  const longest = Math.max(...names.map((name) => name.length));
  const count = Math.max(1, Math.min(3, Math.floor((columns + 2) / (longest + 2))));
  if (count === 1) return names;
  const width = Math.floor((columns - (count - 1) * 2) / count);
  const rows: string[] = [];
  for (let index = 0; index < names.length; index += count) {
    rows.push(names.slice(index, index + count).map((name) => pad(truncate(name, width), width)).join("  ").trimEnd());
  }
  return rows;
}

export function renderTerminal(report: SkillUsageReportV1, options: TerminalRenderOptions = {}): string {
  const isTTY = options.isTTY ?? false;
  const columns = Math.max(40, options.columns ?? 80);
  const narrow = isTTY && columns < 60;
  const range = report.query.range.kind === "all"
    ? `All history · as of ${localDate(report.query.range.as_of, report.query.timezone)}`
    : `${report.query.range.from} – ${report.query.range.until}`;
  const project = report.query.project ? `Project ${report.query.project.name}` : "All projects";
  const names = new Map<string, number>();
  for (const skill of [...report.skills, ...report.zero_load_skills]) names.set(skill.name, (names.get(skill.name) ?? 0) + 1);
  const displayName = (name: string, id: string) => (names.get(name) ?? 0) > 1 ? `${name} [${id.slice(0, 8)}]` : name;
  const currentSkillCount = report.coverage.inventory_status === "unavailable"
    ? undefined
    : report.skills.length + report.zero_load_skills.length;
  const summary = `${report.summary.loads} loads · ${report.summary.sessions_with_loads} sessions`;
  const loadedCount = currentSkillCount === undefined ? undefined : `${report.skills.length} / ${currentSkillCount} skills loaded`;
  const lines = [
    `Skill usage · ${report.query.platform}`,
    "",
    ...(narrow ? [range, project, summary, ...(loadedCount ? [loadedCount] : [])] : [`${range} · ${project}`, [summary, loadedCount].filter(Boolean).join(" · ")]),
    "",
    `Loaded skills · ${report.skills.length}`,
  ];

  if (report.skills.length === 0) {
    lines.push("No Skill Load detected in selected range.");
  } else {
    const rendered = report.skills.map((skill) => ({
      name: displayName(skill.name, skill.id),
      loads: skill.loads,
      sessions: skill.sessions,
      date: localDate(skill.last_detected_at, report.query.timezone),
    }));
    const desiredNameWidth = Math.max("Skill".length, ...rendered.map((skill) => skill.name.length));
    const nameWidth = isTTY
      ? Math.max(12, Math.min(48, columns - 32, desiredNameWidth))
      : desiredNameWidth;
    const loadsWidth = Math.max("Loads".length, ...rendered.map((skill) => String(skill.loads).length));
    const sessionsWidth = Math.max("Sessions".length, ...rendered.map((skill) => String(skill.sessions).length));
    const rankWidth = String(rendered.length).length;
    if (narrow) {
      rendered.forEach((skill, index) => {
        const prefix = `${index + 1}. `;
        lines.push(`${prefix}${truncate(skill.name, columns - prefix.length)}`);
        lines.push(`   ${skill.loads} loads · ${skill.sessions} sessions · ${skill.date}`);
      });
    } else {
      lines.push(`${left("#", rankWidth)}  ${pad("Skill", nameWidth)}  ${left("Loads", loadsWidth)}  ${left("Sessions", sessionsWidth)}  Last load`);
      rendered.forEach((skill, index) => {
        lines.push(`${left(index + 1, rankWidth)}  ${pad(isTTY ? truncate(skill.name, nameWidth) : skill.name, nameWidth)}  ${left(skill.loads, loadsWidth)}  ${left(skill.sessions, sessionsWidth)}  ${skill.date}`);
      });
    }
  }

  if (report.coverage.inventory_status === "unavailable") {
    lines.push("", "Current Skill inventory unavailable.");
  } else {
    const zeroNames = report.zero_load_skills.map((skill) => displayName(skill.name, skill.id));
    lines.push("", `Not loaded in this range · ${zeroNames.length}`);
    lines.push(...(isTTY ? zeroGrid(zeroNames, columns) : zeroNames.length > 0 ? zeroNames : ["None."]));
  }

  const output = `${lines.join("\n")}\n`;
  assertSafeOutput(output);
  return output;
}
