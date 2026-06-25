import { MultiDirectedGraph } from "graphology";
import path from "path";

export type NodeType =
  | "file"
  | "media"
  | "function"
  | "class"
  | "intent"
  | "type"
  | "interface"
  | "enum"
  | "struct"
  | "trait"
  | "macro";
export type EdgeType =
  | "imports"
  | "calls"
  | "defines"
  | "explains"
  | "references";
export type ConfidenceType = "EXTRACTED" | "INFERRED" | "AMBIGUOUS";

export interface NodeData {
  type: NodeType;
  name: string;
  file: string;
  startLine: number;
  unresolved?: boolean;
  reason?: string;
  metadata?: Record<string, unknown> & {
    endLine?: number;
    callerFile?: string;
    callerLine?: number;
    message?: string;
  };
}


export interface EdgeData {
  type: EdgeType;
  confidence: ConfidenceType;
  metadata?: Record<string, unknown>;
}

/**
 * Creates and returns a new production-ready Graphology Knowledge Graph instance.
 * We use a "directed" graph because imports and function calls have a specific direction.
 * We allow "multi" edges because two nodes might have multiple relationships.
 */
export function createKnowledgeGraph(): MultiDirectedGraph<NodeData, EdgeData> {
  const graph = new MultiDirectedGraph<NodeData, EdgeData>();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = graph as any;

  const originalAddEdge = graph.addEdge.bind(graph);
  g.addEdge = (source: string, target: string, attributes?: EdgeData): string => {
    if (source === target) return "";
    return originalAddEdge(source, target, attributes);
  };

  const originalAddEdgeWithKey = graph.addEdgeWithKey.bind(graph);
  g.addEdgeWithKey = (key: string, source: string, target: string, attributes?: EdgeData): string => {
    if (source === target) return "";
    return originalAddEdgeWithKey(key, source, target, attributes);
  };

  const originalMergeEdge = graph.mergeEdge.bind(graph);
  g.mergeEdge = (source: string, target: string, attributes?: EdgeData) => {
    if (source === target) return ["", false];
    return originalMergeEdge(source, target, attributes);
  };

  const originalMergeEdgeWithKey = graph.mergeEdgeWithKey.bind(graph);
  g.mergeEdgeWithKey = (key: string, source: string, target: string, attributes?: EdgeData) => {
    if (source === target) return ["", false];
    return originalMergeEdgeWithKey(key, source, target, attributes);
  };

  return graph;
}

/**
 * Resolution pass: After all files are parsed, any `unresolved_fn::X` ghost node
 * is matched against real defined functions in the graph (`someFile::function::X`).
 * If a match is found, all edges to the ghost are rewired to the real node,
 * and the ghost node is deleted. This eliminates duplicate nodes for the same function.
 */
export function resolveCallGraph(
  graph: MultiDirectedGraph<NodeData, EdgeData>,
): void {
  // Build a lookup map: name -> list of real node IDs
  const realDefs = new Map<string, string[]>();
  for (const nodeId of graph.nodes()) {
    const data = graph.getNodeAttributes(nodeId);
    if (!nodeId.startsWith("unresolved::") && (
      data.type === "function" || 
      data.type === "class" || 
      data.type === "type" || 
      data.type === "interface" || 
      data.type === "enum" ||
      data.type === "struct" ||
      data.type === "trait" ||
      data.type === "macro"
    )) {
      const name = data.name;
      if (!realDefs.has(name)) {
        realDefs.set(name, []);
      }
      realDefs.get(name)!.push(nodeId);
    }
  }

  // Find all ghost nodes and rewire them
  const ghosts = graph.nodes().filter((n) => n.startsWith("unresolved::"));
  for (const ghostId of ghosts) {
    const ghostData = graph.getNodeAttributes(ghostId);
    let name = ghostData.name;
    if (name.includes(".")) {
      name = name.split(".").pop() || name;
    }
    if (name.includes("::")) {
      name = name.split("::").pop() || name;
    }
    const candidates = realDefs.get(name);

    if (candidates && candidates.length > 0) {
      let realId = candidates[0]!;
      let bestScore = -1;

      for (const candidateId of candidates) {
        const candidateData = graph.getNodeAttributes(candidateId);
        let score = 0;

        // 1. Same file directory priority (crucial for same-package Go/Java/C++ files)
        if (path.dirname(candidateData.file) === path.dirname(ghostData.file)) {
          score += 10;
        }
        // 2. Same language/file extension priority
        if (path.extname(candidateData.file) === path.extname(ghostData.file)) {
          score += 5;
        }

        if (score > bestScore) {
          bestScore = score;
          realId = candidateId;
        }
      }

      // Rewire all incoming edges (callers → ghost) to (callers → real)
      for (const edgeId of graph.inEdges(ghostId)) {
        const src = graph.source(edgeId);
        const edgeData = graph.getEdgeAttributes(edgeId);
        if (src === realId) continue;
        if (!graph.hasEdge(src, realId)) {
          graph.addEdge(src, realId, edgeData);
        }
      }
      // Drop the ghost node (also removes its edges automatically)
      graph.dropNode(ghostId);
    }
  }
}
