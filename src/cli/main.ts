#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { analyzeSkillUsage } from "../core/analyze.js";
import type { ProgressSnapshot } from "../core/types.js";
import { CodexSkillScanner } from "../codex/scan.js";
import { renderJson } from "../render/json.js";
import { renderTerminal } from "../render/terminal.js";
import { parseCliArgs } from "./args.js";

const HELP = `Usage: skillusage [options]

Default: --days 30

  --days 7|30|90
  --from YYYY-MM-DD --until YYYY-MM-DD
  --all
  --timezone IANA
  --project NAME_OR_ID
  --codex-home PATH
  --jobs 1..4
  --json
  --help
  --version
`;

interface Output {
  write(value: string): unknown;
  isTTY?: boolean;
  columns?: number;
}

interface CliIo {
  stdout: Output;
  stderr: Output;
}

function progressLine(completed: number, total: number, processed: number, totalBytes: number, elapsed: number): string {
  const mib = (value: number) => `${(value / 1024 / 1024).toFixed(value >= 1024 * 1024 * 1024 ? 0 : 1)} MiB`;
  const percent = totalBytes > 0 ? Math.floor((processed / totalBytes) * 100) : total === 0 ? 100 : 0;
  const seconds = Math.floor(elapsed / 1000);
  return `\r扫描 ${completed}/${total} 个文件 · ${mib(processed)}/${mib(totalBytes)} · ${percent}% · ${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "unknown error";
  return message.replace(/\/Users\/[^/]+/g, "<user>");
}

export async function runCli(args: string[], io: CliIo = process): Promise<number> {
  try {
    const options = parseCliArgs(args);
    if (options.help) {
      io.stdout.write(HELP);
      return 0;
    }
    if (options.version) {
      io.stdout.write("0.1.1\n");
      return 0;
    }
    let wroteProgress = false;
    let lastProgress = 0;
    const scanner = new CodexSkillScanner();
    const onProgress = io.stderr.isTTY ? (snapshot: ProgressSnapshot) => {
      if (snapshot.elapsedMs - lastProgress < 250) return;
      lastProgress = snapshot.elapsedMs;
      io.stderr.write(progressLine(
        snapshot.completedFiles,
        snapshot.totalFiles,
        snapshot.processedBytes,
        snapshot.totalBytes,
        snapshot.elapsedMs,
      ));
      wroteProgress = true;
    } : undefined;
    const scan = await scanner.scan(options.request, onProgress);
    if (wroteProgress) io.stderr.write("\n");
    if (scan.sourceStats.filesScanned === 0) {
      io.stderr.write("No recognizable Codex history found. Use --codex-home to select another local directory.\n");
      return 2;
    }
    const report = analyzeSkillUsage(options.request, scan, "0.1.1");
    io.stdout.write(options.json ? renderJson(report) : renderTerminal(report, {
      isTTY: Boolean(io.stdout.isTTY),
      columns: io.stdout.columns,
    }));
    return 0;
  } catch (error) {
    const message = safeMessage(error);
    io.stderr.write(`${message}\n`);
    if (/unsafe report output|invalid report schema/.test(message)) return 4;
    if (/date|timezone|option|--|project|history found/.test(message)) return 2;
    return 3;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  process.exitCode = await runCli(process.argv.slice(2));
}
