# Project Instructions

- Keep the version aligned in `package.json`, `package-lock.json`, and `src/cli/main.ts`.
- On every version bump, review the user-visible changes since the previous version and update `RELEASE_NOTES.md`; keep unreleased and published changes clearly separated.
- Keep `bin.skillusage` as `dist/cli/main.js`; npm removes the entry when it starts with `./`.
- Before publishing, run the full test suite and `npm publish --dry-run --access public`; treat package auto-correction as a release blocker.
- CI runs on Windows; invoke npm from Node child processes through `cmd.exe /c`, not `npm.cmd` directly.
- Publish only from a clean, pushed commit, then verify the registry version and `latest` tag.
