# skillusage

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
Skill usage · codex

2026-08-01 – 2026-08-31 · All projects
28 loads · 12 sessions · 2 / 3 skills loaded

Loaded skills · 2
#  Skill                    Loads  Sessions  Last load
1  brainstorming               16         9  2026-08-30
2  test-driven-development     12         8  2026-08-30

Not loaded in this range · 1
review
```

- **Usage count:** how often each skill was used, according to the counting rules below.
- **Sessions:** conversations in which the skill was used. A conversation can use several skills, so row counts do not add up to the summary.
- **Last used:** the most recent recorded use in the selected timezone.

The full ranking sorts by usage count, sessions, and most recent use, descending; ties sort by name. A separate alphabetical list shows currently available skills with no recorded use in the selected range. Zero does not mean a skill is useless or should be removed.

## Choose a range or project

```bash
npx @uujx/skillusage@latest --days 7
npx @uujx/skillusage@latest --days 90
npx @uujx/skillusage@latest --from 2026-08-01 --until 2026-08-31
npx @uujx/skillusage@latest --days 30 --project my-project
npx @uujx/skillusage@latest --all
npx @uujx/skillusage@latest --days 30 --json > skillusage.json
npx @uujx/skillusage@latest --help
```

Replace `my-project` with your repository name. Both explicit dates are inclusive. Choose one date mode: `--days`, `--from` with `--until`, or `--all`.

Additional options: `--timezone Asia/Shanghai` sets the calendar timezone; `--codex-home PATH` selects a data directory (default: `~/.codex`); `--jobs 1..4` sets file concurrency (default: 4).

Without a project filter, the list of skills with no recorded use uses current global skills. With a project filter, it also includes that project's current skills. Historically used skills remain in the ranking even if no longer installed. The header's skill total combines ranked skills and the list of skills with no recorded use; it is not a count of current installations.

## How counting works

skillusage scans local `sessions/` and `archived_sessions/` logs and reads the current skill configuration. We measure **use** through a detected **load**: a supported tool record confirms a successful read of a recognized skill entry file, `SKILL.md`. The current CLI labels these counts `Loads` and the latest date `Last load`.

- Recognizes supported `cat`, `sed`, `head`, and `tail` reads, including supported nodes within compound commands. It never executes historical commands.
- Handles `CommandExecution`, older `exec_command` call/result records, and custom `exec` records.
- Uses session skill declarations, current installations, and known Codex skill locations to identify entries. Skills with the same normalized name are grouped, including moved or updated installations; matching the current file's contents is not required.
- Removes fork copies with the same call ID within date-selected candidate files, then counts each skill at most once per turn. Separate turns count separately.
- Excludes path mentions, searches, writes, failed reads, and reads it cannot confirm.

These are detected entry reads, not completed workflows or a measure of skill effectiveness. Unsupported or missing records can lead to undercounts. JSON includes `coverage` for scan quality and current skill-list availability; the terminal keeps these diagnostics out of the main list. JSON also distinguishes no detection in a selected range from no detection across complete available history.

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
