import fs from "fs";
import path from "path";
import { MultiDirectedGraph } from "graphology";
import { NodeData, EdgeData, NodeType, EdgeType, ConfidenceType } from "./graph.js";

export interface QueryResultNode {
  id: string;
  name: string;
  type: string;
  file: string;
  line: number;
  metadata?: Record<string, unknown>;
  links?: { incoming: number; outgoing: number };
}

export interface QueryResult {
  target: QueryResultNode;
  incoming: Array<{ source: QueryResultNode; relation: string; confidence: string }>;
  outgoing: Array<{ target: QueryResultNode; relation: string; confidence: string }>;
}

function normalizeId(id: string): string {
  return id.replace(/\\/g, "/");
}

function loadGraph(targetDir: string): MultiDirectedGraph<NodeData, EdgeData> {
  const graphPath = path.join(targetDir, ".geraph", "graph.json");
  if (!fs.existsSync(graphPath)) {
    throw new Error("Graph data not found. Run 'geraph scan' first.");
  }

  const rawData = JSON.parse(fs.readFileSync(graphPath, "utf-8"));
  const graph = new MultiDirectedGraph<NodeData, EdgeData>();
  
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const nodes = (rawData.nodes || []) as Array<Record<string, any>>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const edges = (rawData.edges || []) as Array<Record<string, any>>;

  nodes.forEach((n) => {
    const nid = normalizeId(n.id as string);
    if (!graph.hasNode(nid)) {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { id, name, type, file, startLine, ...metadata } = n;
      graph.addNode(nid, {
        name: (name as string) || "",
        type: type as NodeType,
        file: normalizeId((file as string) || ""),
        startLine: (startLine as number) || 0,
        metadata: (metadata as Record<string, unknown>) || {},
      });
    }
  });

  edges.forEach((e) => {
    const source = normalizeId(e.source);
    const target = normalizeId(e.target);
    if (graph.hasNode(source) && graph.hasNode(target)) {
      graph.addEdge(source, target, {
        type: (e.relation || e.type) as EdgeType,
        confidence: e.confidence as ConfidenceType,
        metadata: e.metadata || {},
      });
    }
  });

  return graph;
}

export interface SearchResultNode {
  id: string;
  name: string;
  type: string;
  file: string;
  links: number;
}

export async function searchGraph(
  targetDir: string,
  term: string,
  targetType?: string
): Promise<SearchResultNode[]> {
  const graph = loadGraph(targetDir);
  const lowerTerm = term.toLowerCase();
  
  const results: SearchResultNode[] = [];
  
  graph.forEachNode((nodeId, attr) => {
    if (targetType && attr.type !== targetType) return;
    
    // Match if the ID or the Name includes the search term
    if (nodeId.toLowerCase().includes(lowerTerm) || (attr.name && attr.name.toLowerCase().includes(lowerTerm))) {
      results.push({
        id: nodeId,
        name: attr.name,
        type: attr.type,
        file: attr.file,
        links: graph.degree(nodeId)
      });
    }
  });

  // Sort by number of connections (most important nodes first)
  return results.sort((a, b) => b.links - a.links);
}

export async function queryGraph(
  targetDir: string,
  symbol: string,
  targetType?: string,
  targetSource?: string
): Promise<QueryResult> {
  const graph = loadGraph(targetDir);

  // Find node by exact ID first, then fuzzy match name
  const normSymbol = normalizeId(symbol);
  let targetNodeId = graph.hasNode(normSymbol) ? normSymbol : null;

  // If a specific type or source is requested and the exact ID match fails them, discard it.
  if (targetNodeId && (targetType || targetSource)) {
      const attr = graph.getNodeAttributes(targetNodeId);
      if (targetType && attr.type !== targetType) {
          targetNodeId = null;
      }
      if (targetNodeId && targetSource) {
          const normSource = normalizeId(targetSource);
          if (!attr.file.toLowerCase().endsWith(normSource.toLowerCase())) {
             targetNodeId = null;
          }
      }
  }

  if (!targetNodeId) {
    // Attempt Case-Sensitive Match First
    targetNodeId = graph.findNode((nodeId, attr) => {
      if (targetType && attr.type !== targetType) return false;
      if (targetSource) {
          const normSource = normalizeId(targetSource);
          if (!attr.file.endsWith(normSource)) return false;
      }
      return (attr && attr.name && attr.name === symbol) || 
      nodeId === normSymbol ||
      nodeId.endsWith("/" + normSymbol) ||
      nodeId.endsWith("::" + normSymbol);
    }) ?? null;
  }

  if (!targetNodeId) {
    // Fallback to Case-Insensitive Match
    targetNodeId = graph.findNode((nodeId, attr) => {
      if (targetType && attr.type !== targetType) return false;
      if (targetSource) {
          const normSource = normalizeId(targetSource);
          if (!attr.file.toLowerCase().endsWith(normSource.toLowerCase())) return false;
      }
      return (attr && attr.name && attr.name.toLowerCase() === symbol.toLowerCase()) || 
      nodeId.toLowerCase() === normSymbol.toLowerCase() ||
      nodeId.toLowerCase().endsWith("/" + normSymbol.toLowerCase()) ||
      nodeId.toLowerCase().endsWith("::" + normSymbol.toLowerCase());
    }) ?? null;
  }

  if (!targetNodeId) {
    const typeMsg = targetType ? ` of type '${targetType}'` : "";
    const sourceMsg = targetSource ? ` in source '${targetSource}'` : "";
    throw new Error(`Symbol '${symbol}'${typeMsg}${sourceMsg} not found in the graph.`);
  }

  const targetAttr = graph.getNodeAttributes(targetNodeId);
  const result: QueryResult = {
    target: {
      id: targetNodeId,
      name: targetAttr.name,
      type: targetAttr.type,
      file: targetAttr.file,
      line: targetAttr.startLine,
      metadata: targetAttr.metadata,
      links: {
        incoming: graph.inDegree(targetNodeId),
        outgoing: graph.outDegree(targetNodeId),
      },
    },
    incoming: [],
    outgoing: [],
  };

  const collectEdges = (nodeId: string, isOutgoing: boolean, seenKeys: Set<string>) => {
    const iterator = isOutgoing ? graph.forEachOutEdge.bind(graph) : graph.forEachInEdge.bind(graph);
    
    iterator(nodeId, (edge, attr, source, target) => {
      const neighborId = isOutgoing ? target : source;
      
      // Strict Self-Loop Filter: Never include the target node itself in neighbor lists
      if (neighborId === targetNodeId) return;
      
      const key = `${neighborId}:${attr.type}`;
      if (seenKeys.has(key)) return;
      seenKeys.add(key);

      const neighborAttr = graph.getNodeAttributes(neighborId);
      
      const nodeInfo = {
        id: neighborId,
        name: neighborAttr.name,
        type: neighborAttr.type,
        file: neighborAttr.file,
        line: neighborAttr.startLine,
      };

      if (isOutgoing) {
        result.outgoing.push({
          relation: attr.type,
          confidence: attr.confidence,
          target: nodeInfo
        });
      } else {
        result.incoming.push({
          relation: attr.type,
          confidence: attr.confidence,
          source: nodeInfo
        });
      }
    });
  };

  const seenIn = new Set<string>();
  const seenOut = new Set<string>();

  // Only collect DIRECT neighbors.
  // This ensures 100% parity with the HTML graph visualization.
  collectEdges(targetNodeId, false, seenIn);
  collectEdges(targetNodeId, true, seenOut);

  return result;
}
