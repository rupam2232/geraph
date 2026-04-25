import { simpleGit, SimpleGit } from "simple-git";
import type { MultiDirectedGraph } from "graphology";
import type { NodeData, EdgeData } from "./graph.js";

/**
 * Enriches the knowledge graph with Temporal Fact Management using Git Blame.
 * This function identifies the most recent commit for every class and function
 * and injects the human-written commit message into the graph as an 'intent' node.
 */
export async function enrichWithGit(
  graph: MultiDirectedGraph<NodeData, EdgeData>,
  targetDir: string,
) {
  let git: SimpleGit;
  try {
    git = simpleGit(targetDir);
    const isRepo = await git.checkIsRepo();
    if (!isRepo) return;
  } catch {
    // Git is not installed or the directory is not a repo
    return;
  }

  // Cache to avoid duplicate git show calls for the same commit
  const commitMessages = new Map<string, string>();

  // Find all internal functions and classes
  const targetNodes = graph.nodes().filter((id) => {
    const data = graph.getNodeAttributes(id);
    return (
      (data.type === "function" || data.type === "class") &&
      !data.metadata?.external
    );
  });

  // Group by file to minimize git blame child processes
  const nodesByFile = new Map<string, string[]>();
  for (const nodeId of targetNodes) {
    const filePath = nodeId.split("::")[0];
    if (!filePath) continue;

    if (!nodesByFile.has(filePath)) nodesByFile.set(filePath, []);
    nodesByFile.get(filePath)!.push(nodeId);
  }

  for (const [filePath, nodeIds] of nodesByFile.entries()) {
    try {
      // Use raw git blame --line-porcelain because it prints a hash for every single line
      const blameOut = await git.raw(["blame", "--line-porcelain", filePath]);
      const lines = blameOut.split("\n");

      const lineToCommit = new Map<number, string>();

      for (const line of lines) {
        // Porcelain format: <40-char-hash> <originalLine> <finalLine> <linesInGroup>
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

      // Map AST nodes to their creating/modifying commit
      for (const nodeId of nodeIds) {
        const data = graph.getNodeAttributes(nodeId);
        const startLine = data.metadata?.startLine as number | undefined;

        if (startLine && lineToCommit.has(startLine)) {
          const hash = lineToCommit.get(startLine)!;

          // Skip uncommitted lines (usually 0000000000000000000000000000000000000000)
          if (hash.startsWith("00000000")) continue;

          if (!commitMessages.has(hash)) {
            const msg = await git.raw(["show", "-s", "--format=%B", hash]);
            commitMessages.set(hash, msg.trim());
          }

          const commitMsg = commitMessages.get(hash)!;
          const intentNodeId = `commit::${hash}`;

          // Create the intent node
          if (!graph.hasNode(intentNodeId)) {
            graph.addNode(intentNodeId, {
              type: "intent",
              name: `Commit ${hash.substring(0, 7)}`,
              metadata: { message: commitMsg },
            });
          }

          // Link the commit to the function/class it modified
          graph.addEdge(intentNodeId, nodeId, {
            type: "explains",
            confidence: "EXTRACTED", // The commit mathematically changed this function
          });
        }
      }
    } catch {
      // Ignore files not tracked by git
    }
  }
}
