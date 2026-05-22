import { parentPort } from "worker_threads";
import { MultiDirectedGraph } from "graphology";
import { NodeData, EdgeData } from "./graph.js";
import { WorkerMessage, WorkerNode, WorkerEdge, WorkerTask } from "./types.js";
import path from "path";
import { parseTypeScript } from "../parsers/typescript.js";
import { parseJson } from "../parsers/json.js";
import { parseMarkdown } from "../parsers/markdown.js";
import { parseMedia } from "../parsers/media.js";

const MEDIA_EXTS = new Set([
  "png", "jpg", "jpeg", "svg", "gif", "webp", 
  "mp4", "webm", "mp3", "wav"
]);

function getContextualAliases(filePath: string, aliasMap: import("./types.js").AliasMap): import("./types.js").PathAlias[] {
  let current = path.dirname(filePath);
  while (current) {
    const aliases = aliasMap[current];
    if (aliases) return aliases;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return [];
}

parentPort?.on("message", async (msg: WorkerTask) => {
  const { filePath, aliasMap } = msg;
  const localGraph = new MultiDirectedGraph<NodeData, EdgeData>();

  try {
    // Seed local graph with the file node itself so parsers can add 'defines' edges
    localGraph.addNode(filePath, {
      type: "file",
      name: path.basename(filePath),
      file: filePath,
      startLine: 0,
      metadata: {
        extension: path.extname(filePath),
      },
    });

    const ext = filePath.split(".").pop()?.toLowerCase() || "";

    if (ext === "ts" || ext === "js" || ext === "tsx" || ext === "jsx") {
      const aliases = getContextualAliases(filePath, aliasMap || {});
      parseTypeScript(filePath, localGraph, aliases);
    } else if (ext === "json") {
      parseJson(filePath, localGraph);
    } else if (ext === "md") {
      parseMarkdown(filePath, localGraph);
    } else if (MEDIA_EXTS.has(ext)) {
      parseMedia(filePath, localGraph);
    } else {
      // Unknown file type is already seeded as 'file' node above
    }

    const nodes: WorkerNode[] = localGraph.nodes().map((id) => ({
      id,
      attr: localGraph.getNodeAttributes(id),
    }));
    const edges: WorkerEdge[] = localGraph.edges().map((id) => ({
      source: localGraph.source(id),
      target: localGraph.target(id),
      attr: localGraph.getEdgeAttributes(id),
    }));

    const response: WorkerMessage = { nodes, edges };
    parentPort?.postMessage(response);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    parentPort?.postMessage({ error: errorMessage });
  }
});
