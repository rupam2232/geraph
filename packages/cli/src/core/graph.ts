import { MultiDirectedGraph } from "graphology";

export type NodeType =
  | "file"
  | "media"
  | "function"
  | "class"
  | "variable"
  | "intent";
export type EdgeType =
  | "imports"
  | "calls"
  | "defines"
  | "superseded_by"
  | "explains";
export type ConfidenceType = "EXTRACTED" | "INFERRED" | "AMBIGUOUS";

export interface NodeData {
  type: NodeType;
  name: string;
  metadata?: Record<string, unknown> & {
    startLine?: number;
    endLine?: number;
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
  return new MultiDirectedGraph<NodeData, EdgeData>();
}
