import { parentPort, workerData } from "node:worker_threads";

import { scanFile, type FileResult, type SessionFile } from "./scan.js";
import type { AnalysisRequest } from "../core/types.js";
import type { ResolvedInventory } from "./inventory.js";

interface WorkerData {
  reportProgress: boolean;
  request: AnalysisRequest;
  inventory: {
    result: ResolvedInventory["result"];
    aliases: Array<[string, ResolvedInventory["result"]["skills"][number]]>;
    acceptedRoots: readonly string[];
  };
}

const data = workerData as WorkerData;
const inventory: ResolvedInventory = {
  result: data.inventory.result,
  aliases: new Map(data.inventory.aliases),
  acceptedRoots: data.inventory.acceptedRoots,
};

async function handleScan(message: { kind: "scan"; file: SessionFile }): Promise<void> {
  if (message.kind !== "scan") return;
  let pendingBytes = 0;
  let lastProgress = Date.now();
  const flush = () => {
    if (data.reportProgress && pendingBytes > 0) parentPort?.postMessage({ kind: "progress", bytes: pendingBytes });
    pendingBytes = 0;
    lastProgress = Date.now();
  };
  try {
    const onBytes = data.reportProgress ? (delta: number) => {
      pendingBytes += delta;
      if (pendingBytes >= 4 * 1024 * 1024 || Date.now() - lastProgress >= 250) flush();
    } : undefined;
    const result = await scanFile(message.file, data.request, inventory, onBytes);
    flush();
    parentPort?.postMessage({ kind: "result", result });
  } catch {
    flush();
    parentPort?.postMessage({ kind: "result", result: { ordinal: message.file.ordinal, sessions: [], bytesScanned: 0, unreadableRecords: 1, projectRoots: [] } satisfies FileResult });
  }
}

let queue = Promise.resolve();
parentPort?.on("message", (message: { kind: "scan"; file: SessionFile }) => {
  queue = queue.then(() => handleScan(message));
});
