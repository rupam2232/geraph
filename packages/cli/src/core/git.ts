import { simpleGit, SimpleGit } from "simple-git";
import path from "path";
import fs from "fs";
import type { MultiDirectedGraph } from "graphology";
import type { NodeData, EdgeData } from "./graph.js";
import chalk from "chalk";

const CACHE_VERSION = "1";

const GIT_ENRICH_SKIP = new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "shrinkwrap.json",
  "npm-shrinkwrap.json",
  "Gemfile.lock",
  "Cargo.lock",
  "Pipfile.lock",
  "poetry.lock",
  "composer.lock",
  "packages.lock.json",
  "CHANGELOG.md",
  "CHANGELOG.txt",
  "go.sum",
  "uv.lock",
  "gradle.lockfile",
]);

interface GitCacheBlameEntry {
  mtime: number;
  nodeToCommits: Record<string, string[]>;
}

interface CommitMetadata {
  message: string;
  author: string;
  date: string;
}

interface GitCache {
  version: string;
  commits: Record<string, CommitMetadata>;
  blame: Record<string, GitCacheBlameEntry>;
}

async function loadCache(cacheFile: string): Promise<GitCache | null> {
  try {
    const raw = await fs.promises.readFile(cacheFile, "utf-8");
    const parsed = JSON.parse(raw) as GitCache;
    if (parsed.version !== CACHE_VERSION) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function saveCache(cacheFile: string, cache: GitCache): Promise<void> {
  try {
    const serialized = JSON.stringify(cache);
    const dir = path.dirname(cacheFile);
    const tempFile = path.join(dir, `git-cache.${Date.now()}.${Math.random().toString(36).substring(2)}.tmp`);
    await fs.promises.writeFile(tempFile, serialized, "utf-8");
    try {
      await fs.promises.rename(tempFile, cacheFile);
    } catch {
      try {
        await fs.promises.copyFile(tempFile, cacheFile);
        await fs.promises.unlink(tempFile);
      } catch {
        // ignore fallback failure
      }
    }
  } catch {
    // Non-fatal
  }
}

export async function enrichWithGit(
  graph: MultiDirectedGraph<NodeData, EdgeData>,
  targetDir: string,
  force = false,
) {
  let git: SimpleGit;

  try {
    git = simpleGit(targetDir);
    const isRepo = await git.checkIsRepo();
    if (!isRepo) return;

    // Detect shallow clones (common in GitHub Actions / CI).
    const isShallow = (await git.raw(["rev-parse", "--is-shallow-repository"])).trim() === "true";
    if (isShallow) {
      console.warn(chalk.yellow("\n\u26A0\u3000Shallow Git repository detected. Skipping Git enrichment to save time."));
      return;
    }
  } catch {
    return;
  }

  const outDir = path.join(targetDir, ".geraph");
  const cacheDir = path.join(outDir, "cache");
  if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
  const cacheFile = path.join(cacheDir, "git-cache.json");

  const cache: GitCache = (force ? null : await loadCache(cacheFile)) ?? {
    version: CACHE_VERSION,
    commits: {},
    blame: {},
  };

  if (force) {
    cache.blame = {};
  }

  const allDiscoveredHashes = new Set<string>();
  const globalNodeCommits = new Map<string, string[]>();


  const nodesByFile = new Map<string, string[]>();

  // Group functions, classes, etc. by their file path
  for (const nodeId of graph.nodes()) {
    const data = graph.getNodeAttributes(nodeId);
    if (data.metadata?.external) continue;
    
    if (!["file", "media", "intent"].includes(data.type)) {
      const filePath = nodeId.split("::")[0];
      if (!filePath) continue;
      if (!nodesByFile.has(filePath)) nodesByFile.set(filePath, []);
      nodesByFile.get(filePath)!.push(nodeId);
    }
  }

  // If a file has NO functions/classes, map commits to the file node itself
  for (const nodeId of graph.nodes()) {
    const data = graph.getNodeAttributes(nodeId);
    if ((data.type === "file" || data.type === "media") && !data.metadata?.external) {
      const basename = path.basename(nodeId);
      if (GIT_ENRICH_SKIP.has(basename)) continue;
      if (!nodesByFile.has(nodeId)) {
        nodesByFile.set(nodeId, [nodeId]);
      }
    }
  }

  let trackedFiles: Set<string> | null = null;
  try {
    const trackedRaw = await git.raw(["ls-files"]);
    trackedFiles = new Set(
      trackedRaw
        .split("\n")
        .map((f) => f.trim())
        .filter(Boolean)
        .map((f) => path.normalize(path.resolve(targetDir, f)))
    );
  } catch {
    trackedFiles = null;
  }

  const filePaths = Array.from(nodesByFile.keys());
  const BATCH_SIZE = 8;
  for (let i = 0; i < filePaths.length; i += BATCH_SIZE) {
    const batch = filePaths.slice(i, i + BATCH_SIZE);
    await Promise.all(
      batch.map(async (filePath) => {
        const nodeIds = nodesByFile.get(filePath)!;
        try {
          const normalizedPath = path.normalize(filePath);
          if (trackedFiles && !trackedFiles.has(normalizedPath)) {
            return;
          }

          const stat = fs.statSync(filePath);
          const currentMtime = stat.mtimeMs;
          const cachedBlame = cache.blame[normalizedPath];

          let nodeCommits: Record<string, string[]> = {};
          if (!force && cachedBlame && cachedBlame.mtime === currentMtime) {
            nodeCommits = cachedBlame.nodeToCommits;
          } else {
            const blameOut = await git.raw(["blame", "--line-porcelain", filePath]);
            const allLineToCommit = new Map<number, string>();
            let maxLine = 0;
            
            let pos = 0;
            while (pos < blameOut.length) {
              const nextNewline = blameOut.indexOf("\n", pos);
              const end = nextNewline === -1 ? blameOut.length : nextNewline;
              const line = blameOut.substring(pos, end);
              pos = end + 1;

              if (line.length >= 45 && line.charCodeAt(40) === 32) {
                const hash = line.substring(0, 40);
                let isHex = true;
                for (let j = 0; j < 40; j++) {
                  const c = hash.charCodeAt(j);
                  if (!((c >= 48 && c <= 57) || (c >= 97 && c <= 102) || (c >= 65 && c <= 70))) {
                    isHex = false;
                    break;
                  }
                }
                if (isHex) {
                  const secondSpace = line.indexOf(" ", 41);
                  if (secondSpace !== -1) {
                    const thirdSpace = line.indexOf(" ", secondSpace + 1);
                    const endOfLineNum = thirdSpace === -1 ? line.length : thirdSpace;
                    const lineNumStr = line.substring(secondSpace + 1, endOfLineNum);
                    const lineNum = parseInt(lineNumStr, 10);
                    if (!isNaN(lineNum)) {
                      allLineToCommit.set(lineNum, hash);
                      if (lineNum > maxLine) maxLine = lineNum;
                    }
                  }
                }
              }
            }

            for (const nodeId of nodeIds) {
              let startLine = graph.getNodeAttributes(nodeId).startLine as number | undefined;
              let endLine = graph.getNodeAttributes(nodeId).metadata?.endLine as number | undefined;
              
              if (!startLine) {
                const nodeType = graph.getNodeAttributes(nodeId).type;
                if (nodeType === "file" || nodeType === "media") {
                  startLine = 1;
                  endLine = maxLine;
                } else {
                  continue;
                }
              }
              const finalEnd = endLine || startLine;
              
              const uniqueCommits = new Set<string>();
              for (let i = startLine; i <= finalEnd; i++) {
                const hash = allLineToCommit.get(i);
                if (hash && !hash.startsWith("00000000")) {
                  uniqueCommits.add(hash);
                }
              }
              nodeCommits[nodeId] = Array.from(uniqueCommits);
            }

            cache.blame[normalizedPath] = {
              mtime: currentMtime,
              nodeToCommits: nodeCommits,
            };
          }

          for (const nodeId of nodeIds) {
            const commits = nodeCommits[nodeId] || [];
            globalNodeCommits.set(nodeId, commits);
            for (const hash of commits) {
              allDiscoveredHashes.add(hash);
            }
          }
        } catch {
          // Skip untracked/unblameable files silently
        }
      }),
    );
  }

  // Bulk Fetch Missing Commit Metadata
  const missingHashes = Array.from(allDiscoveredHashes).filter(hash => !cache.commits[hash]);
  
  if (missingHashes.length > 0) {
    const CHUNK_SIZE = 50;
    for (let i = 0; i < missingHashes.length; i += CHUNK_SIZE) {
      const chunk = missingHashes.slice(i, i + CHUNK_SIZE);
      try {
        const rawOut = await git.raw([
          "show",
          "--no-patch",
          "--format=%H===GERAPH===%an===GERAPH===%aI===GERAPH===%B",
          ...chunk
        ]);
        
        // Split output by hash blocks. Using %H===GERAPH=== as an anchor
        const blocks = rawOut.split(/(?=[0-9a-f]{40}===GERAPH===)/);
        
        for (const block of blocks) {
          if (!block.trim()) continue;
          const parts = block.split("===GERAPH===");
          if (parts.length >= 4) {
            const hash = parts[0]!.trim();
            cache.commits[hash] = {
              author: parts[1]!.trim(),
              date: parts[2]!.trim(),
              message: parts.slice(3).join("===GERAPH===").trim(),
            };
          }
        }
      } catch {
        console.warn(chalk.yellow("\n\u26A0\u3000Warning: Failed to bulk-fetch metadata for some commits."));
      }
    }
  }

  // Synchronous Graph Insertion
  for (const [nodeId, commits] of globalNodeCommits.entries()) {
    for (const hash of commits) {
      const meta = cache.commits[hash];
      if (!meta) continue;

      const intentNodeId = `commit::${hash}`;
      if (!graph.hasNode(intentNodeId)) {
        graph.addNode(intentNodeId, {
          type: "intent",
          name: `Commit ${hash.substring(0, 7)}`,
          file: "", // Intent nodes are global to the commit
          startLine: 0,
          metadata: { 
            message: meta.message,
            author: meta.author,
            date: meta.date
          },
        });
      }

      if (!graph.hasEdge(intentNodeId, nodeId)) {
        graph.addEdge(intentNodeId, nodeId, {
          type: "explains",
          confidence: "EXTRACTED",
        });
      }
    }
  }

  await saveCache(cacheFile, cache);
}
