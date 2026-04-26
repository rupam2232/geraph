import { simpleGit, SimpleGit } from "simple-git";
import path from "path";
import fs from "fs";
import type { MultiDirectedGraph } from "graphology";
import type { NodeData, EdgeData } from "./graph.js";

/**
 * Maximum number of recent commits to process.
 * Keeps the CLI fast even on repos with thousands of commits.
 */
const COMMIT_LIMIT = 100;

/** Versioned cache schema — bump when structure changes to force invalidation. */
const CACHE_VERSION = "1";

/**
 * Files to exclude from git enrichment. These are auto-generated or dependency
 * files whose commit history carries no architectural signal for an LLM.
 * Every commit that touches package-lock.json says "installed a package" —
 * that context is already captured on the source file that ADDED the dependency.
 */
const GIT_ENRICH_SKIP = new Set([
  // Lock files — updated by package managers, not humans
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "shrinkwrap.json",
  "npm-shrinkwrap.json",
  // Generated / compiled output
  "Gemfile.lock",
  "Cargo.lock",
  "Pipfile.lock",
  "poetry.lock",
  "composer.lock",
  "packages.lock.json",
  // Changelogs and generated docs (high churn, low signal)
  "CHANGELOG.md",
  "CHANGELOG.txt",
]);

interface GitCacheBlameEntry {
  /** File mtime (ms) at the time the blame was run. */
  mtime: number;
  /** Maps final line number → full commit hash. */
  lineToCommit: Record<string, string>;
}

interface GitCache {
  version: string;
  /** HEAD hash at the time of the last log pass. If it matches current HEAD,
   *  we can skip git log entirely and use cachedFileCommits. */
  head: string;
  /** commit hash → message. Commits are immutable, so this is valid forever. */
  commitMessages: Record<string, string>;
  /** file absolute path → list of commit hashes that touched it (last COMMIT_LIMIT). */
  fileCommits: Record<string, string[]>;
  /** file absolute path → blame entry (invalidated per-file by mtime). */
  blame: Record<string, GitCacheBlameEntry>;
}

function loadCache(cacheFile: string): GitCache | null {
  try {
    const raw = fs.readFileSync(cacheFile, "utf-8");
    const parsed = JSON.parse(raw) as GitCache;
    if (parsed.version !== CACHE_VERSION) return null;
    return parsed;
  } catch {
    return null;
  }
}

function saveCache(cacheFile: string, cache: GitCache): void {
  try {
    fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2), "utf-8");
  } catch {
    // Non-fatal — caching is a best-effort optimization
  }
}

/**
 * Enriches the knowledge graph with Temporal Fact Management.
 *
 * Uses a two-level cache stored in `.graphine/git-cache.json`:
 *   - Commit messages: immutable once committed, cached forever by hash.
 *   - git log (Pass 1): cached by HEAD hash. If HEAD hasn't changed, the
 *     entire log pass is skipped (zero git processes).
 *   - git blame (Pass 2): cached per file by mtime. If a file hasn't been
 *     modified since the last scan, its blame data is reused.
 *
 * Pass 1 — Single git log call (O(1) git processes, capped at COMMIT_LIMIT):
 *   Links each recent commit to every file node it modified.
 *
 * Pass 2 — git blame per file (function-level granularity):
 *   Links the most recent commit that touched a function/class start line.
 */
export async function enrichWithGit(
  graph: MultiDirectedGraph<NodeData, EdgeData>,
  targetDir: string,
) {
  let git: SimpleGit;
  let repoRoot: string;
  let currentHead: string;

  try {
    git = simpleGit(targetDir);
    const isRepo = await git.checkIsRepo();
    if (!isRepo) return;

    repoRoot = (await git.raw(["rev-parse", "--show-toplevel"])).trim();
    currentHead = (await git.raw(["rev-parse", "HEAD"])).trim();
  } catch {
    return;
  }

  const outDir = path.join(targetDir, ".graphine");
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const cacheFile = path.join(outDir, "git-cache.json");

  const cache: GitCache = loadCache(cacheFile) ?? {
    version: CACHE_VERSION,
    head: "",
    commitMessages: {},
    fileCommits: {},
    blame: {},
  };

  /**
   * Returns the commit message for a hash.
   * Uses the in-memory / disk cache before calling git.
   */
  async function getCommitMessage(hash: string): Promise<string> {
    if (cache.commitMessages[hash]) return cache.commitMessages[hash]!;
    const msg = await git.raw(["show", "-s", "--format=%B", hash]);
    const trimmed = msg.trim();
    cache.commitMessages[hash] = trimmed;
    return trimmed;
  }

  /**
   * Ensures a commit intent node exists in the graph.
   * Always fetches the FULL commit body (%B) — never just the subject line.
   * The first call per hash hits git; all subsequent calls use the disk cache.
   */
  async function ensureCommitNode(hash: string): Promise<string> {
    const intentNodeId = `commit::${hash}`;
    if (!graph.hasNode(intentNodeId)) {
      const message = await getCommitMessage(hash);
      graph.addNode(intentNodeId, {
        type: "intent",
        name: `Commit ${hash.substring(0, 7)}`,
        metadata: { message },
      });
    }
    return intentNodeId;
  }

  // Build a lookup: normalized absolute path → graph node ID.
  // Excludes lock/generated files that carry no architectural signal.
  const fileNodeLookup = new Map<string, string>();
  for (const nodeId of graph.nodes()) {
    const data = graph.getNodeAttributes(nodeId);
    if (data.type === "file" && !data.metadata?.external) {
      const basename = path.basename(nodeId);
      if (GIT_ENRICH_SKIP.has(basename)) continue;
      fileNodeLookup.set(path.normalize(nodeId), nodeId);
    }
  }

  // ── Pass 1: git log (file-level links) ──────────────────────────────────
  const headChanged = cache.head !== currentHead;

  if (headChanged) {
    // HEAD has advanced — re-run git log to pick up new commits.
    // A single command returns all files touched by the last N commits.
    const logOut = await git.raw([
      "log",
      `--max-count=${COMMIT_LIMIT}`,
      "--name-only",
      "--format=COMMIT:%H|%s",
      "HEAD",
    ]);

    let currentHash: string | null = null;
    let currentSubject: string | null = null;

    for (const rawLine of logOut.split("\n")) {
      const line = rawLine.trim();
      if (!line) continue;

      if (line.startsWith("COMMIT:")) {
        const payload = line.slice("COMMIT:".length);
        const pipeIdx = payload.indexOf("|");
        currentHash = pipeIdx >= 0 ? payload.slice(0, pipeIdx) : payload;
        currentSubject = pipeIdx >= 0 ? payload.slice(pipeIdx + 1) : "";
        // Note: we intentionally do NOT pre-cache the subject as the commit message.
        // getCommitMessage() always fetches the full body (%B) via 'git show'.
        // currentSubject is kept only to avoid an unused-variable lint error.
        void currentSubject;
        continue;
      }

      if (!currentHash) continue;

      const absolutePath = path.normalize(path.join(repoRoot, line));
      if (!cache.fileCommits[absolutePath]) cache.fileCommits[absolutePath] = [];
      if (!cache.fileCommits[absolutePath]!.includes(currentHash)) {
        cache.fileCommits[absolutePath]!.push(currentHash);
      }
    }

    cache.head = currentHead;
  }
  // If HEAD is unchanged, cache.fileCommits is already up-to-date — skip git log.

  // Wire cached file-commit data into the graph
  for (const [absolutePath, hashes] of Object.entries(cache.fileCommits)) {
    const fileNodeId = fileNodeLookup.get(absolutePath);
    if (!fileNodeId) continue;

    for (const hash of hashes) {
      const intentNodeId = await ensureCommitNode(hash);
      if (!graph.hasEdge(intentNodeId, fileNodeId)) {
        graph.addEdge(intentNodeId, fileNodeId, {
          type: "explains",
          confidence: "EXTRACTED",
        });
      }
    }
  }

  // ── Pass 2: git blame per file (function-level) ──────────────────────────
  const funcClassNodes = graph.nodes().filter((id) => {
    const data = graph.getNodeAttributes(id);
    return (
      (data.type === "function" || data.type === "class") &&
      !data.metadata?.external
    );
  });

  const nodesByFile = new Map<string, string[]>();
  for (const nodeId of funcClassNodes) {
    const filePath = nodeId.split("::")[0];
    if (!filePath) continue;
    if (!nodesByFile.has(filePath)) nodesByFile.set(filePath, []);
    nodesByFile.get(filePath)!.push(nodeId);
  }

  for (const [filePath, nodeIds] of nodesByFile.entries()) {
    try {
      // Check if the cached blame is still valid by comparing file mtime
      let lineToCommit: Map<number, string>;
      const normalizedPath = path.normalize(filePath);
      const stat = fs.statSync(filePath);
      const currentMtime = stat.mtimeMs;
      const cachedBlame = cache.blame[normalizedPath];

      if (cachedBlame && cachedBlame.mtime === currentMtime) {
        // File hasn't changed since last scan — reuse cached blame data
        lineToCommit = new Map(
          Object.entries(cachedBlame.lineToCommit).map(([k, v]) => [
            parseInt(k, 10),
            v,
          ]),
        );
      } else {
        // File changed or no cache — run git blame and cache the result
        const blameOut = await git.raw([
          "blame",
          "--line-porcelain",
          filePath,
        ]);
        const lines = blameOut.split("\n");
        lineToCommit = new Map<number, string>();

        for (const line of lines) {
          if (line.match(/^[0-9a-f]{40} /)) {
            const parts = line.split(" ");
            const hash = parts[0];
            const finalLineStr = parts[2];
            if (!hash || !finalLineStr) continue;
            const currentLine = parseInt(finalLineStr, 10);
            if (!lineToCommit.has(currentLine)) {
              lineToCommit.set(currentLine, hash);
            }
          }
        }

        // Persist to cache
        cache.blame[normalizedPath] = {
          mtime: currentMtime,
          lineToCommit: Object.fromEntries(
            [...lineToCommit.entries()].map(([k, v]) => [String(k), v]),
          ),
        };
      }

      for (const nodeId of nodeIds) {
        const data = graph.getNodeAttributes(nodeId);
        const startLine = data.metadata?.startLine as number | undefined;
        if (!startLine || !lineToCommit.has(startLine)) continue;

        const hash = lineToCommit.get(startLine)!;
        if (hash.startsWith("00000000")) continue;

        const intentNodeId = await ensureCommitNode(hash);
        if (!graph.hasEdge(intentNodeId, nodeId)) {
          graph.addEdge(intentNodeId, nodeId, {
            type: "explains",
            confidence: "EXTRACTED",
          });
        }
      }
    } catch {
      // File not tracked by git
    }
  }

  // Persist the updated cache to disk
  saveCache(cacheFile, cache);
}
