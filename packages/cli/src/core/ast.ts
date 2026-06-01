import { availableParallelism } from "os";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { Worker } from "worker_threads";
import chalk from "chalk";
import { Ora } from "ora";
import { MultiDirectedGraph } from "graphology";
import { NodeData, EdgeData } from "./graph.js";
import { WorkerMessage, WorkerTask, WorkerNode, WorkerEdge } from "./types.js";
import { buildAliasMap } from "./alias.js";

interface StatEntry {
  size: number;
  mtimeMs: number;
  hash: string;
}

interface StatIndex {
  __version__?: string;
  [filePath: string]: StatEntry | string | undefined;
}

const STAT_INDEX_VERSION = "2";

export async function extractAst(
  files: string[],
  graph: MultiDirectedGraph<NodeData, EdgeData>,
  targetDir: string,
  spinner: Ora,
  force = false,
): Promise<void> {
  const aliasMap = buildAliasMap(files);
  const astCacheDir = path.join(targetDir, ".geraph", "cache", "ast");
  if (!fs.existsSync(astCacheDir))
    fs.mkdirSync(astCacheDir, { recursive: true });

  const statIndexFile = path.join(targetDir, ".geraph", "cache", "stat-index.json");
  let statIndex: StatIndex = {};
  let statIndexDirty = false;
  if (!force && fs.existsSync(statIndexFile)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(statIndexFile, "utf-8"));
      if (parsed.__version__ === STAT_INDEX_VERSION) {
        statIndex = parsed;
      } else {
        statIndex = { __version__: STAT_INDEX_VERSION };
        statIndexDirty = true;
      }
    } catch {
      statIndex = { __version__: STAT_INDEX_VERSION };
      statIndexDirty = true;
    }
  } else {
    statIndex = { __version__: STAT_INDEX_VERSION };
    statIndexDirty = true;
  }

  let cachedCount = 0;

  const resultsMap = new Map<
    string,
    {
      nodes?: WorkerNode[];
      edges?: WorkerEdge[];
    }
  >();

  const queue: {
    file: string;
    action: "parse" | "load-cache";
    cachePath?: string;
    expectedStat?: { size: number; mtimeMs: number };
  }[] = [];

  for (const file of files) {
    try {
      const stat = fs.statSync(file);
      const entry = statIndex[file];
      if (!force && entry && typeof entry === "object" && entry.size === stat.size && entry.mtimeMs === stat.mtimeMs) {
        const cachePath = path.join(astCacheDir, `${entry.hash}.json`);
        if (fs.existsSync(cachePath)) {
          queue.push({
            file,
            action: "load-cache",
            cachePath,
          });
          cachedCount++;
          continue;
        }
      }
      
      queue.push({
        file,
        action: "parse",
        expectedStat: { size: stat.size, mtimeMs: stat.mtimeMs },
      });
    } catch {
      queue.push({
        file,
        action: "parse",
      });
    }
  }

  if (cachedCount === files.length) {
    spinner.stop();
    console.log(
      chalk.green(`⚡ Fully cached! No files needed re-parsing.`),
    );
    spinner.start();
  } else {
    spinner.text = chalk.gray(
      `Parsing AST for ${files.length - cachedCount} files (${cachedCount} cached)...`,
    );
  }

  if (queue.length > 0) {
    const numWorkers = Math.min(availableParallelism(), queue.length);
    const workerPath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "core",
      "worker.js",
    );

    let completedCount = 0;
    const workers = Array.from(
      { length: numWorkers },
      () => new Worker(workerPath),
    );

    await Promise.all(
      workers.map(async (worker) => {
        while (queue.length > 0) {
          const item = queue.shift();
          if (!item) break;
          const { file, action, cachePath, expectedStat } = item;

          await new Promise<void>((resolve) => {
            const onMessage = (msg: WorkerMessage) => {
              if (msg.error) {
                console.error(
                  chalk.yellow(
                    `\n\u26A0\u3000Worker error for ${file}: ${msg.error}`,
                  ),
                );
              } else {
                resultsMap.set(file, { nodes: msg.nodes, edges: msg.edges });

                if (action === "parse" && msg.hash && expectedStat) {
                  statIndex[file] = {
                    size: expectedStat.size,
                    mtimeMs: expectedStat.mtimeMs,
                    hash: msg.hash,
                  };
                  statIndexDirty = true;
                }
              }
              completedCount++;
              spinner.text = chalk.gray(
                `Parsing AST: ${completedCount}/${files.length} files...`,
              );
              worker.off("message", onMessage);
              worker.off("error", onError);
              resolve();
            };

            const onError = (err: Error) => {
              console.error(
                chalk.red(`Worker error on ${file}: ${err.message}`),
              );
              completedCount++;
              worker.off("message", onMessage);
              worker.off("error", onError);
              resolve();
            };

            worker.on("message", onMessage);
            worker.on("error", onError);
            worker.postMessage({
              filePath: file,
              projectRoot: targetDir,
              aliasMap,
              action,
              cachePath,
            } satisfies WorkerTask);
          });
        }
        await worker.terminate();
      }),
    );
  }

  if (statIndexDirty) {
    try {
      const tempPath = path.join(targetDir, ".geraph", "cache", `stat-index.${Date.now()}.${Math.random().toString(36).substring(2)}.tmp`);
      fs.writeFileSync(tempPath, JSON.stringify(statIndex, null, 2), "utf-8");
      try {
        fs.renameSync(tempPath, statIndexFile);
      } catch {
        try {
          fs.copyFileSync(tempPath, statIndexFile);
          fs.unlinkSync(tempPath);
        } catch {
          // ignore lock issues on Windows
        }
      }
    } catch {
      // ignore
    }
  }

  for (const file of files) {
    const res = resultsMap.get(file);
    if (!res) continue;

    res.nodes?.forEach((n) => {
      if (!graph.hasNode(n.id)) {
        graph.addNode(n.id, n.attr);
      } else if (n.attr.type !== "file") {
        graph.mergeNodeAttributes(n.id, n.attr);
      }
    });

    res.edges?.forEach((e) => {
      if (!graph.hasEdge(e.source, e.target)) {
        graph.addEdge(e.source, e.target, e.attr);
      }
    });
  }
}
