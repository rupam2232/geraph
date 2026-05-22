import { availableParallelism } from "os";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { Worker } from "worker_threads";
import crypto from "crypto";
import chalk from "chalk";
import { Ora } from "ora";
import { MultiDirectedGraph } from "graphology";
import { NodeData, EdgeData } from "./graph.js";
import { WorkerMessage, WorkerTask, AliasMap } from "./types.js";

function getFileHash(
  filePath: string,
  rootDir: string,
  aliasMap: AliasMap,
): string {
  const content = fs.readFileSync(filePath);
  const relPath = path.relative(rootDir, filePath).toLowerCase();

  const h = crypto.createHash("sha256");
  h.update(content);
  h.update(Buffer.from("\x00"));
  h.update(Buffer.from(relPath));
  h.update(Buffer.from("\x00"));
  h.update(Buffer.from(JSON.stringify(aliasMap)));
  return h.digest("hex");
}

export async function extractAst(
  files: string[],
  graph: MultiDirectedGraph<NodeData, EdgeData>,
  targetDir: string,
  aliasMap: AliasMap,
  spinner: Ora,
): Promise<void> {
  const astCacheDir = path.join(targetDir, ".geraph", "cache", "ast");
  if (!fs.existsSync(astCacheDir))
    fs.mkdirSync(astCacheDir, { recursive: true });

  const queue: { file: string; hash: string }[] = [];
  let cachedCount = 0;

  // 1. Gather all parsed elements deterministically
  const resultsMap = new Map<
    string,
    {
      nodes?: { id: string; attr: NodeData }[];
      edges?: { source: string; target: string; attr: EdgeData }[];
    }
  >();

  for (const file of files) {
    try {
      const hash = getFileHash(file, targetDir, aliasMap);
      const cachePath = path.join(astCacheDir, `${hash}.json`);

      if (fs.existsSync(cachePath)) {
        const cached = JSON.parse(fs.readFileSync(cachePath, "utf-8")) as {
          nodes?: { id: string; attr: NodeData }[];
          edges?: { source: string; target: string; attr: EdgeData }[];
        };
        resultsMap.set(file, { nodes: cached.nodes, edges: cached.edges });
        cachedCount++;
      } else {
        queue.push({ file, hash });
      }
    } catch {
      queue.push({ file, hash: "" });
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
      `Parsing AST for ${queue.length} files (${cachedCount} cached)...`,
    );
  }

  if (queue.length > 0) {
    const numWorkers = Math.min(availableParallelism(), queue.length);
    const workerPath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "core",
      "worker.js",
    );

    let parsedCount = 0;
    const workers = Array.from(
      { length: numWorkers },
      () => new Worker(workerPath),
    );

    await Promise.all(
      workers.map(async (worker) => {
      while (queue.length > 0) {
        const item = queue.shift();
        if (!item) break;
        const { file, hash } = item;

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

              if (hash) {
                try {
                  const cachePath = path.join(astCacheDir, `${hash}.json`);
                  fs.writeFileSync(
                    cachePath,
                    JSON.stringify({ nodes: msg.nodes, edges: msg.edges }),
                  );
                } catch {
                  // ignore
                }
              }
            }
            parsedCount++;
            spinner.text = chalk.gray(
              `Parsing AST: ${parsedCount}/${
                files.length - cachedCount
              } files...`,
            );
            worker.off("message", onMessage);
            worker.off("error", onError);
            resolve();
          };

          const onError = (err: Error) => {
            console.error(
              chalk.red(`Worker error on ${file}: ${err.message}`),
            );
            parsedCount++;
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
          } satisfies WorkerTask);
        });
      }
      await worker.terminate();
    }),
  );
  }

  // 2. Insert into the graph sequentially and deterministically
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
