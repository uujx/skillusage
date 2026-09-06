import { assertReportShape } from "../core/report-schema.js";
import { assertSafeOutput } from "../core/safety.js";
import type { SkillUsageReportV1 } from "../core/types.js";

export function renderJson(report: SkillUsageReportV1): string {
  assertReportShape(report);
  const output = `${JSON.stringify(report, null, 2)}\n`;
  assertSafeOutput(output);
  return output;
}
