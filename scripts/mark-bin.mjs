import { chmod } from "node:fs/promises";

await chmod(new globalThis.URL("../dist/cli/main.js", import.meta.url), 0o755);
