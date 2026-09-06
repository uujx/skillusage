import type {
  AnalysisRequest,
  PlatformScanResult,
  SkillLoad,
  SkillUsageReportV1,
} from "./types.js";

function localDate(instant: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(instant));
  const value = Object.fromEntries(
    parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]),
  );
  return `${value.year}-${value.month}-${value.day}`;
}

function isInRange(load: SkillLoad, request: AnalysisRequest): boolean {
  const value = Date.parse(load.occurredAt);
  if (Number.isNaN(value)) return false;
  if (request.range.kind === "all") return value <= Date.parse(request.range.asOf);
  return value >= Date.parse(request.range.from) && value < Date.parse(request.range.untilExclusive);
}

function normalizedName(name: string): string {
  return name.normalize("NFKC").toLocaleLowerCase("en-US");
}

export function analyzeSkillUsage(
  request: AnalysisRequest,
  scan: PlatformScanResult,
  toolVersion: string,
): SkillUsageReportV1 {
  const sessions = scan.project
    ? scan.sessions.filter((session) => session.project?.id === scan.project?.id)
    : scan.sessions;
  const uniqueLoads = new Map<string, { load: SkillLoad; sessionKey: string }>();

  for (const session of sessions) {
    for (const load of session.loads) {
      if (!isInRange(load, request)) continue;
      const key = `${session.sessionKey}\u0000${load.turnKey}\u0000${load.skill.id}`;
      const existing = uniqueLoads.get(key);
      if (!existing || load.occurredAt < existing.load.occurredAt) {
        uniqueLoads.set(key, { load, sessionKey: session.sessionKey });
      }
    }
  }

  const aggregated = new Map<
    string,
    { id: string; name: string; loads: number; sessions: Set<string>; lastDetectedAt: string }
  >();
  for (const { load, sessionKey } of uniqueLoads.values()) {
    const item = aggregated.get(load.skill.id) ?? {
      id: load.skill.id,
      name: load.skill.name,
      loads: 0,
      sessions: new Set<string>(),
      lastDetectedAt: load.occurredAt,
    };
    item.loads += 1;
    item.sessions.add(sessionKey);
    if (load.occurredAt > item.lastDetectedAt) item.lastDetectedAt = load.occurredAt;
    aggregated.set(item.id, item);
  }

  const skills = [...aggregated.values()]
    .map((item) => ({
      id: item.id,
      name: item.name,
      loads: item.loads,
      sessions: item.sessions.size,
      last_detected_at: item.lastDetectedAt,
    }))
    .sort((left, right) =>
      right.loads - left.loads ||
      right.sessions - left.sessions ||
      right.last_detected_at.localeCompare(left.last_detected_at) ||
      normalizedName(left.name).localeCompare(normalizedName(right.name)) ||
      left.id.localeCompare(right.id),
    );

  const historicalNames = new Set(
    [...aggregated.values()].map((item) => normalizedName(item.name)),
  );
  const historyComplete =
    scan.sourceStats.unreadableRecords +
      sessions.reduce((sum, session) => sum + session.unreadableRecords, 0) ===
      0 &&
    sessions.reduce((sum, session) => sum + session.unresolvedLoadCandidates, 0) === 0;
  const zeroLoadSkills = scan.inventory.status === "unavailable"
    ? []
    : scan.inventory.skills
      .filter((skill) => !aggregated.has(skill.id))
      .map((skill) => ({
        id: skill.id,
        name: skill.name,
        detection_status:
          request.range.kind === "all" && historyComplete && !historicalNames.has(normalizedName(skill.name))
            ? "never_detected" as const
            : "not_detected_in_range" as const,
      }))
      .sort((left, right) =>
        normalizedName(left.name).localeCompare(normalizedName(right.name)) ||
        left.id.localeCompare(right.id),
      );
  const unreadableRecords =
    scan.sourceStats.unreadableRecords +
    sessions.reduce((sum, session) => sum + session.unreadableRecords, 0);
  const unresolvedLoadCandidates = sessions.reduce(
    (sum, session) => sum + session.unresolvedLoadCandidates,
    0,
  );

  return {
    schema_version: "1.0.0",
    tool_version: toolVersion,
    query: {
      platform: scan.platform,
      range: request.range.kind === "all"
        ? { kind: "all", as_of: request.range.asOf }
        : {
          kind: "bounded",
          from: localDate(request.range.from, request.timezone),
          until: localDate(new Date(Date.parse(request.range.untilExclusive) - 1).toISOString(), request.timezone),
        },
      timezone: request.timezone,
      ...(scan.project ? { project: scan.project } : {}),
    },
    coverage: {
      history_complete: historyComplete,
      inventory_status: scan.inventory.status,
      files_scanned: scan.sourceStats.filesScanned,
      bytes_scanned: scan.sourceStats.bytesScanned,
      sessions_scanned: sessions.length,
      unreadable_records: unreadableRecords,
      unresolved_load_candidates: unresolvedLoadCandidates,
      unresolved_inventory_sources: scan.inventory.unresolvedSources,
    },
    summary: {
      loads: uniqueLoads.size,
      sessions_with_loads: new Set([...uniqueLoads.values()].map((item) => item.sessionKey)).size,
    },
    skills,
    zero_load_skills: zeroLoadSkills,
  };
}
