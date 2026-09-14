import type {
  AnalysisRequest,
  PlatformScanResult,
  SkillLoad,
  SkillRequest,
  SkillUsageReportV1,
} from "./types.js";

const dateFormatters = new Map<string, Intl.DateTimeFormat>();

function localDate(instant: string, timezone: string): string {
  let formatter = dateFormatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" });
    dateFormatters.set(timezone, formatter);
  }
  const parts = formatter.formatToParts(new Date(instant));
  const value = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function isInRange(event: SkillLoad | SkillRequest, request: AnalysisRequest): boolean {
  const value = Date.parse(event.occurredAt);
  if (Number.isNaN(value)) return false;
  return request.range.kind === "all"
    ? value <= Date.parse(request.range.asOf)
    : value >= Date.parse(request.range.from) && value < Date.parse(request.range.untilExclusive);
}

function normalizedName(name: string): string {
  return name.normalize("NFKC").toLocaleLowerCase("en-US");
}

function dateRange(from: string, until: string): string[] {
  const result: string[] = [];
  for (let day = Date.parse(`${from}T00:00:00.000Z`); day <= Date.parse(`${until}T00:00:00.000Z`); day += 86_400_000) {
    result.push(new Date(day).toISOString().slice(0, 10));
  }
  return result;
}

type EventEntry<T extends SkillLoad | SkillRequest> = { event: T; sessionKey: string };

function dailyCounts<T extends SkillLoad | SkillRequest>(entries: Iterable<EventEntry<T>>, timezone: string): Map<string, number> {
  const result = new Map<string, number>();
  for (const { event } of entries) {
    const date = localDate(event.occurredAt, timezone);
    result.set(date, (result.get(date) ?? 0) + 1);
  }
  return result;
}

function aggregate<T extends SkillLoad | SkillRequest>(
  entries: Iterable<EventEntry<T>>,
  timezone: string,
  countKey: "loads" | "requests",
  dateKey: "last_detected_at" | "last_requested_at",
  dailyKey: "daily_loads" | "daily_requests",
) {
  const result = new Map<string, {
    id: string; name: string; count: number; sessions: Set<string>; last: string; daily: Map<string, number>;
  }>();
  for (const { event, sessionKey } of entries) {
    const item = result.get(event.skill.id) ?? {
      id: event.skill.id, name: event.skill.name, count: 0, sessions: new Set<string>(), last: event.occurredAt, daily: new Map<string, number>(),
    };
    item.count += 1;
    item.sessions.add(sessionKey);
    if (event.occurredAt > item.last) item.last = event.occurredAt;
    const date = localDate(event.occurredAt, timezone);
    item.daily.set(date, (item.daily.get(date) ?? 0) + 1);
    result.set(item.id, item);
  }
  return [...result.values()]
    .map((item) => ({
      id: item.id, name: item.name, [countKey]: item.count, sessions: item.sessions.size, [dateKey]: item.last,
      [dailyKey]: [...item.daily.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([date, count]) => ({ date, count })),
    }))
    .sort((left, right) =>
      Number(right[countKey]) - Number(left[countKey]) ||
      right.sessions - left.sessions ||
      String(right[dateKey]).localeCompare(String(left[dateKey])) ||
      normalizedName(left.name).localeCompare(normalizedName(right.name)) ||
      left.id.localeCompare(right.id),
    );
}

export function analyzeSkillUsage(request: AnalysisRequest, scan: PlatformScanResult, toolVersion: string): SkillUsageReportV1 {
  const sessions = scan.project ? scan.sessions.filter((session) => session.project?.id === scan.project?.id) : scan.sessions;
  const uniqueLoads = new Map<string, EventEntry<SkillLoad>>();
  const uniqueRequests = new Map<string, EventEntry<SkillRequest>>();
  for (const session of sessions) {
    for (const load of session.loads) {
      if (!isInRange(load, request)) continue;
      const key = `${session.sessionKey}\u0000${load.turnKey}\u0000${load.skill.id}`;
      const existing = uniqueLoads.get(key);
      if (!existing || load.occurredAt < existing.event.occurredAt) uniqueLoads.set(key, { event: load, sessionKey: session.sessionKey });
    }
    for (const requested of session.requests ?? []) {
      if (!isInRange(requested, request)) continue;
      const key = `${session.sessionKey}\u0000${requested.turnKey}\u0000${requested.skill.id}`;
      const existing = uniqueRequests.get(key);
      if (!existing || requested.occurredAt < existing.event.occurredAt) uniqueRequests.set(key, { event: requested, sessionKey: session.sessionKey });
    }
  }
  const skills = aggregate(uniqueLoads.values(), request.timezone, "loads", "last_detected_at", "daily_loads") as SkillUsageReportV1["skills"];
  const requestedSkills = aggregate(uniqueRequests.values(), request.timezone, "requests", "last_requested_at", "daily_requests") as SkillUsageReportV1["requested_skills"];
  const loadCountsByDate = dailyCounts(uniqueLoads.values(), request.timezone);
  const requestCountsByDate = dailyCounts(uniqueRequests.values(), request.timezone);
  const unreadableRecords = scan.sourceStats.unreadableRecords;
  const unresolvedLoadCandidates = sessions.reduce((sum, session) => sum + session.unresolvedLoadCandidates, 0);
  const unresolvedRequestCandidates = sessions.reduce((sum, session) => sum + session.unresolvedRequestCandidates, 0);
  const historyComplete = unreadableRecords === 0 && unresolvedLoadCandidates === 0;
  const requestHistoryComplete = scan.sourceStats.requestUnreadableRecords === 0 && unreadableRecords === 0 && unresolvedRequestCandidates === 0;
  const historicalNames = new Set(skills.map((item) => normalizedName(item.name)));
  const zeroLoadSkills = scan.inventory.status === "unavailable" ? [] : scan.inventory.skills
    .filter((skill) => !skills.some((item) => item.id === skill.id))
    .map((skill) => ({
      id: skill.id,
      name: skill.name,
      detection_status: request.range.kind === "all" && historyComplete && !historicalNames.has(normalizedName(skill.name))
        ? "never_detected" as const : "not_detected_in_range" as const,
    }))
    .sort((left, right) => normalizedName(left.name).localeCompare(normalizedName(right.name)) || left.id.localeCompare(right.id));
  const allEvents = [...uniqueLoads.values(), ...uniqueRequests.values()];
  const dates = request.range.kind === "bounded"
    ? dateRange(localDate(request.range.from, request.timezone), localDate(new Date(Date.parse(request.range.untilExclusive) - 1).toISOString(), request.timezone))
    : allEvents.length === 0 ? []
      : dateRange(localDate(allEvents.map((entry) => entry.event.occurredAt).sort()[0]!, request.timezone), localDate(request.range.asOf, request.timezone));
  const activity = dates.map((date) => ({
    date,
    loads: loadCountsByDate.get(date) ?? 0,
    requests: requestCountsByDate.get(date) ?? 0,
  }));
  return {
    schema_version: "1.1.0", tool_version: toolVersion,
    query: {
      platform: scan.platform,
      range: request.range.kind === "all" ? { kind: "all", as_of: request.range.asOf } : {
        kind: "bounded",
        from: localDate(request.range.from, request.timezone),
        until: localDate(new Date(Date.parse(request.range.untilExclusive) - 1).toISOString(), request.timezone),
      },
      timezone: request.timezone,
      ...(scan.project ? { project: scan.project } : {}),
    },
    coverage: {
      history_complete: historyComplete,
      request_history_complete: requestHistoryComplete,
      inventory_status: scan.inventory.status,
      files_scanned: scan.sourceStats.filesScanned,
      bytes_scanned: scan.sourceStats.bytesScanned,
      sessions_scanned: sessions.length,
      unreadable_records: unreadableRecords,
      unresolved_load_candidates: unresolvedLoadCandidates,
      unresolved_request_candidates: unresolvedRequestCandidates,
      unresolved_inventory_sources: scan.inventory.unresolvedSources,
    },
    summary: {
      loads: uniqueLoads.size,
      sessions_with_loads: new Set([...uniqueLoads.values()].map((entry) => entry.sessionKey)).size,
      requests: uniqueRequests.size,
      sessions_with_requests: new Set([...uniqueRequests.values()].map((entry) => entry.sessionKey)).size,
    },
    activity,
    skills,
    requested_skills: requestedSkills,
    zero_load_skills: zeroLoadSkills,
  };
}
