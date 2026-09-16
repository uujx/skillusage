# skillusage

[![npm version](https://img.shields.io/npm/v/@uujx/skillusage.svg)](https://www.npmjs.com/package/@uujx/skillusage) [![npm downloads](https://img.shields.io/npm/dt/@uujx/skillusage.svg)](https://www.npmjs.com/package/@uujx/skillusage) [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

English · [简体中文](./README.zh-CN.md)

See which Codex skills you use most, and which installed skills have no recorded use.

Get a ranked list from your local Codex history, filtered by date or project. No account, API key, or background service required.

## Try it

Requires **Node.js 22+** and local Codex session history.

```bash
npx @uujx/skillusage@latest
```

The default report covers today and the previous 29 days in your local timezone. An interactive terminal shows scanning progress.

## Preview

Illustrative data, not a real user's history:

```text
skillusage · codex · Loaded
2026-08-01 – 2026-08-31 · All projects
78 loads · 23 sessions · 5 skills with loads
Trend ▁▂▃▅▄▆█▅▆▇▅▆ · 31 days
Last 7 complete days: 14 → 21 (+7) · 08-18–08-24 → 08-25–08-31

#  Skill                           Loads  Sess  Last date   Trend
1  brainstorming                     31    12  2026-08-31  ▁▂▃▄▆█▅▆▇▅▆█
2  test-driven-development           24    10  2026-08-30  ·▁▂▃▅█▆▄▅▃▆▇
3  verification-before-completion    12     8  2026-08-31  ··▁▂▄▆█▅▄▃▆█
4  diagnose                           7     4  2026-08-29  ···▁▃█▄▂▁··▃
5  openai-docs                        4     3  2026-08-28  ····▁··█·▁··

8 current skills: no load detected in range · --show-zero
Trend: daily average / bucket; each row scaled independently.
Explicit requests: skillusage --requested
```

- **Usage count:** detected confirmed loads, according to the counting rules below.
- **Sessions:** conversations in which the skill was used. A conversation can use several skills, so row counts do not add up to the summary.
- **Last used:** the most recent recorded use in the selected timezone.

The default report shows every Loaded skill with a detected load. Use `--limit N` for a shorter ranking, `--limit 0` to explicitly request the complete ranking, and `--show-zero` to expand the alphabetical list of currently available skills with no detected load in the selected range. Interactive terminals arrange that list in up to three columns; piped output remains one item per line. Zero does not mean a skill is useless or should be removed.

## Choose a range or project

```bash
npx @uujx/skillusage@latest --days 7
npx @uujx/skillusage@latest --days 90
npx @uujx/skillusage@latest --from 2026-08-01 --until 2026-08-31
npx @uujx/skillusage@latest --days 30 --project my-project
npx @uujx/skillusage@latest --all
npx @uujx/skillusage@latest --days 30 --json > skillusage.json
npx @uujx/skillusage@latest --requested
npx @uujx/skillusage@latest --requested --limit 10
npx @uujx/skillusage@latest --show-zero
npx @uujx/skillusage@latest --help
```

Replace `my-project` with your repository name. Both explicit dates are inclusive. Choose one date mode: `--days`, `--from` with `--until`, or `--all`.

Additional options: `--timezone Asia/Shanghai` sets the calendar timezone; `--codex-home PATH` selects a data directory (default: `~/.codex`); `--jobs 1..4` sets file concurrency (default: 4).

`--requested` replaces the terminal ranking with only new, direct human messages that explicitly name a known `$skill`. It excludes copied fork context, subagent task context, automatic goals, and injected Skill bodies. Requested and Loaded are independent event sets, not a funnel: a request is not proof of a confirmed entry-file read, and a load can occur without an explicit request. `--show-zero` applies only to Loaded. `--json` always emits the complete 1.1.0 report and cannot be combined with `--requested`, `--limit`, or `--show-zero`.

Without a project filter, the list of skills with no recorded use uses current global skills. With a project filter, it also includes that project's current skills. Historically used skills remain in the ranking even if no longer installed. The header's skill total combines ranked skills and the list of skills with no recorded use; it is not a count of current installations.

## How counting works

skillusage scans local `sessions/`, `archived_sessions/`, and the optional local `history.jsonl`, then reads the current skill configuration. It measures **Loaded** through a detected successful read of a recognized `SKILL.md` entry. It measures **Requested** only from a new, direct human message that explicitly names a known `$skill`; system/developer content, inherited fork context, subagent task context, automatic goals, skill injection, tool output, ordinary mentions, and unknown tokens are excluded.

- Recognizes supported `cat`, `sed`, `head`, and `tail` reads, including supported nodes within compound commands. It never executes historical commands.
- Handles `CommandExecution`, older `exec_command` call/result records, and custom `exec` records.
- Uses session skill declarations, current installations, and known Codex skill locations to identify entries. Skills with the same normalized name are grouped, including moved or updated installations; matching the current file's contents is not required.
- Removes fork copies with the same call ID. For no-ID records, it merges only a parent/child copy with a matching explicit or `turn_context` identity; ambiguous records remain visible through Load coverage instead of being silently removed. Each skill counts at most once per turn; separate turns count separately.
- Excludes path mentions, searches, writes, failed reads, and reads it cannot confirm.
- Pairs duplicate explicit messages from rollout and `history.jsonl`. Proven parent/child lineage uses the original message occurrence, so copied context with rewritten timestamps does not create a new request; a human sending the same text again still counts. Raw messages, fingerprints, session IDs, lineage, and paths never enter the public report.

These are detected facts, not completed workflows or a measure of skill effectiveness. Unsupported, missing, conflicting, or ambiguous records can lead to undercounts or incomplete coverage. JSON includes separate Load/Requested `coverage` diagnostics and current skill-list availability; the terminal keeps these diagnostics out of the main list. JSON also distinguishes no detection in a selected range from no detection across complete available history.

## Trends

Each terminal trend has at most 12 points. Every point is the daily average for a near-equal date bucket; `--all` distributes up to 12 equal-time buckets across the complete history and labels the approximate days per bucket. The number beside a ranking row is the only cross-row size comparison: each sparkline is normalized to that row. When at least 14 complete local days are available, the overall row also compares the two latest seven-day windows using raw counts; an unfinished current day is excluded. JSON retains the full daily facts.

See [Release Notes](./RELEASE_NOTES.md) for version-by-version changes.

## Privacy and scope

Analysis runs locally without network requests, uploads, or telemetry. Reports retain skill and project names but exclude conversation text, raw tool output, session IDs, absolute user paths, credentials, and URL query parameters. Progress goes to stderr, leaving `--json` output ready for scripts. Review readable names before sharing a report.

Currently supports **Codex only**, through terminal and JSON reports. Other agent platforms and a Web interface are possible future directions, not available features.

## Contributing

[Report an issue](https://github.com/uujx/skillusage/issues) or contribute through a pull request.

To run from source, execute these commands in the repository directory:

```bash
npm ci
npm run build
node dist/cli/main.js
```

For a counting issue, include the tool version (`--version`), Node.js version, selected options, and expected versus actual counts. Share only a minimal redacted example; do not upload entire session logs.

To check a source change, run `npm run typecheck`, `npm run lint`, and `npm test`. `npm pack --dry-run` builds and lists the release contents without publishing.

## License

[MIT](./LICENSE)
