import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";
import { promisify } from "node:util";

import type { ProjectRef } from "../core/types.js";

const exec = promisify(execFile);

export interface ResolvedProject {
  ref: ProjectRef;
  root: string;
}

export async function projectFromCwd(cwd: string): Promise<ResolvedProject> {
  let root = resolve(cwd);
  try {
    const { stdout } = await exec("git", ["-C", cwd, "rev-parse", "--git-common-dir"], { timeout: 2000 });
    root = resolve(cwd, stdout.trim(), "..");
  } catch {
    // Non-Git directory remains its own project.
  }
  return {
    root,
    ref: {
      id: createHash("sha256").update(`project\u0000${root}`).digest("hex"),
      name: basename(root),
    },
  };
}
