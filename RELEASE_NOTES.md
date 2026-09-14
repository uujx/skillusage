# Release Notes

This file records repository iterations in reverse chronological order. An entry describes verified code changes; it does not by itself mean that the package was published to npm.

## 1.0.0 — Unreleased (2026-09-14)

- Correct `--requested` to count only new, direct human `$skill` messages. Copied fork context, subagent task context, automatic goals, injected Skill bodies, and ambiguous metadata no longer inflate the ranking; unresolved evidence is surfaced through JSON coverage.
- Keep Loaded independent of Requested collection. Proven inherited Loads are merged by call ID or strong turn identity, while ambiguous no-ID records remain visible and lower coverage rather than being silently discarded.
- Show the complete non-zero Loaded ranking by default. `--limit N` now provides an explicit shorter view.
- Add responsive terminal layouts: show Trend as a proper column with one skill per row whenever the current data fits, and use a uniform multi-line fallback only when it does not.
- Add `--show-zero`, with an alphabetical zero-load list arranged in up to three columns on interactive terminals and one item per line in piped output.
- Add daily-average sparklines with at most 12 equal-time buckets, plus raw-count comparison of the latest two complete seven-day windows.
- Make `--all` trends cover the complete history instead of showing only a few active-month points; the output labels the total days and approximate days per bucket.
- Keep progress output consistent with the rest of the CLI by using `Scanning … files`.
- Align the package version at `1.0.0` and extend the JSON schema to `1.1.0` with daily activity data.
- Harden the publish dry-run check with a writable npm cache, an explicit successful-exit requirement, and release-file verification.

## 0.1.2 — 2026-09-07

- Fix the npm executable entry so the published package retains the `skillusage` command.
- Run the npm publish dry-run through `cmd.exe /c` on Windows for CI compatibility.

## 0.1.1 — 2026-09-07

- Recognize Windows Skill entry paths and expand cross-platform regression coverage.
- Keep package, lockfile, CLI, and report version metadata aligned.

## 0.1.0 — 2026-09-07

- Initial local, read-only Codex Skill Load CLI.
- Add date, timezone, project, concurrency, all-history, terminal, and JSON reporting options.
- Add current-inventory zero-load reporting, deterministic aggregation, privacy checks, and worker-based history scanning.
