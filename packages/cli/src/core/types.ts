import { NodeData, EdgeData } from "./graph.js";

export interface WorkerNode {
  id: string;
  attr: NodeData;
}

export interface WorkerEdge {
  source: string;
  target: string;
  attr: EdgeData;
}

export interface PathAlias {
  prefix: string;
  targets: string[];
}

export type AliasMap = Record<string, PathAlias[]>;

export interface WorkerMessage {
  nodes?: WorkerNode[];
  edges?: WorkerEdge[];
  error?: string;
}

export interface WorkerTask {
  filePath: string;
  projectRoot: string;
  aliasMap: AliasMap;
}
