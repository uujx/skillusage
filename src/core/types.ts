export type InventoryStatus = "complete" | "partial" | "unavailable";

export interface AnalysisRequest {
  range:
    | { kind: "bounded"; from: string; untilExclusive: string }
    | { kind: "all"; asOf: string };
  timezone: string;
  projectSelector?: string;
  codexHome: string;
  jobs: 1 | 2 | 3 | 4;
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
  sourceOrdinal?: number;
  recordOrdinal?: number;
}

export interface ScannedSession {
  sessionKey: string;
  project?: ProjectRef;
  loads: SkillLoad[];
  unreadableRecords: number;
  unresolvedLoadCandidates: number;
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
  schema_version: "1.0.0";
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
    inventory_status: InventoryStatus;
    files_scanned: number;
    bytes_scanned: number;
    sessions_scanned: number;
    unreadable_records: number;
    unresolved_load_candidates: number;
    unresolved_inventory_sources: number;
  };
  summary: { loads: number; sessions_with_loads: number };
  skills: Array<{
    id: string;
    name: string;
    loads: number;
    sessions: number;
    last_detected_at: string;
  }>;
  zero_load_skills: Array<{
    id: string;
    name: string;
    detection_status: "not_detected_in_range" | "never_detected";
  }>;
}
