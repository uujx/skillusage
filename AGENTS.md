# Project Instructions

- Keep the version aligned in `package.json`, `package-lock.json`, and `src/cli/main.ts`.
- Keep `bin.skillusage` as `dist/cli/main.js`; npm removes the entry when it starts with `./`.
- Before publishing, run the full test suite and `npm publish --dry-run --access public`; treat package auto-correction as a release blocker.
- Publish only from a clean, pushed commit, then verify the registry version and `latest` tag.
