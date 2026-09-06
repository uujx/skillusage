import type { SkillUsageReportV1 } from "./types.js";

export function assertReportShape(value: unknown): asserts value is SkillUsageReportV1 {
  if (!value || typeof value !== "object") throw new Error("report must be an object");
  const report = value as Partial<SkillUsageReportV1>;
  if (
    report.schema_version !== "1.0.0" ||
    typeof report.tool_version !== "string" ||
    !report.query || typeof report.query !== "object" ||
    !report.coverage || typeof report.coverage !== "object" ||
    !report.summary || typeof report.summary !== "object" ||
    !["complete", "partial", "unavailable"].includes(report.coverage.inventory_status ?? "") ||
    typeof report.coverage.history_complete !== "boolean" ||
    !Number.isInteger(report.coverage.files_scanned) ||
    !Number.isInteger(report.coverage.bytes_scanned) ||
    !Number.isInteger(report.coverage.sessions_scanned) ||
    !Number.isInteger(report.coverage.unreadable_records) ||
    !Number.isInteger(report.coverage.unresolved_load_candidates) ||
    !Number.isInteger(report.coverage.unresolved_inventory_sources) ||
    !Number.isInteger(report.summary.loads) ||
    !Number.isInteger(report.summary.sessions_with_loads) ||
    !Array.isArray(report.skills) ||
    !Array.isArray(report.zero_load_skills)
  ) {
    throw new Error("invalid report schema");
  }
}

export const reportJsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  required: ["schema_version", "tool_version", "query", "coverage", "summary", "skills", "zero_load_skills"],
  properties: {
    schema_version: { const: "1.0.0" },
    tool_version: { type: "string" },
    query: { type: "object" },
    coverage: {
      type: "object",
      required: ["history_complete", "inventory_status", "files_scanned", "bytes_scanned", "sessions_scanned", "unreadable_records", "unresolved_load_candidates", "unresolved_inventory_sources"],
    },
    summary: { type: "object", required: ["loads", "sessions_with_loads"] },
    skills: { type: "array" },
    zero_load_skills: { type: "array" },
  },
} as const;
