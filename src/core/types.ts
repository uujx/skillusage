export type InventoryStatus = "complete" | "partial" | "unavailable";

export interface AnalysisRequest {
  range:
    | { kind: "bounded"; from: string; untilExclusive: string }
    | { kind: "all"; asOf: string };
  timezone: string;
  projectSelector?: string;
  codexHome: string;
  jobs: 1 | 2 | 3 | 4;
  /** Internal scan projection; JSON and --requested require Requested facts. */
  includeRequested?: boolean;
}

export interface ProgressSnapshot {
  completedFiles: number;
  totalFiles: number;
  processedBytes: number;
  totalBytes: number;
  elapsedMs: number;
}

export interface SkillRef {
  id: string;
  name: string;
}

export interface ProjectRef {
  id: string;
  name: string;
}

export interface SkillLoad {
  skill: SkillRef;
  turnKey: string;
  occurredAt: string;
  /** Scanner-private fork dedup metadata; never serialized. */
  callId?: string;
  /** Scanner-private provenance strength for no-call-id lineage matching. */
  turnEvidence?: "explicit" | "context" | "task" | "user";
  sourceOrdinal?: number;
  recordOrdinal?: number;
}

export interface SkillRequest {
  skill: SkillRef;
  turnKey: string;
  occurredAt: string;
  /** Scanner-private exact-message deduplication metadata; never serialized. */
  messageFingerprint?: string;
  /** Scanner-private user-message position for lineage-aware deduplication. */
  messageOrdinal?: number;
  sourceOrdinal?: number;
  recordOrdinal?: number;
}

export interface ScannedSession {
  sessionKey: string;
  /** Scanner-private lineage metadata from the first valid session metadata record. */
  parentSessionKey?: string;
  isSubagent?: boolean;
  metadataConflict?: boolean;
  project?: ProjectRef;
  loads: SkillLoad[];
  requests: SkillRequest[];
  unreadableRecords: number;
  unresolvedLoadCandidates: number;
  unresolvedRequestCandidates: number;
}

export interface InventoryResult {
  status: InventoryStatus;
  skills: SkillRef[];
  unresolvedSources: number;
}

export interface SourceStats {
  filesScanned: number;
  bytesScanned: number;
  unreadableRecords: number;
  requestUnreadableRecords: number;
}

export interface PlatformScanResult {
  platform: string;
  project?: ProjectRef;
  sessions: ScannedSession[];
  inventory: InventoryResult;
  sourceStats: SourceStats;
}

export interface PlatformSkillScanner {
  scan(
    request: AnalysisRequest,
    onProgress?: (snapshot: ProgressSnapshot) => void,
  ): Promise<PlatformScanResult>;
}

export interface SkillUsageReportV1 {
  schema_version: "1.1.0";
  tool_version: string;
  query: {
    platform: string;
    range:
      | { kind: "bounded"; from: string; until: string }
      | { kind: "all"; as_of: string };
    timezone: string;
    project?: ProjectRef;
  };
  coverage: {
    history_complete: boolean;
    request_history_complete: boolean;
    inventory_status: InventoryStatus;
    files_scanned: number;
    bytes_scanned: number;
    sessions_scanned: number;
    unreadable_records: number;
    unresolved_load_candidates: number;
    unresolved_request_candidates: number;
    unresolved_inventory_sources: number;
  };
  summary: { loads: number; sessions_with_loads: number; requests: number; sessions_with_requests: number };
  activity: Array<{ date: string; loads: number; requests: number }>;
  skills: Array<{
    id: string;
    name: string;
    loads: number;
    sessions: number;
    last_detected_at: string;
    daily_loads: Array<{ date: string; count: number }>;
  }>;
  requested_skills: Array<{
    id: string;
    name: string;
    requests: number;
    sessions: number;
    last_requested_at: string;
    daily_requests: Array<{ date: string; count: number }>;
  }>;
  zero_load_skills: Array<{
    id: string;
    name: string;
    detection_status: "not_detected_in_range" | "never_detected";
  }>;
}
