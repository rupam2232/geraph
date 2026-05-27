import fs from "fs";
import path from "path";
import { MultiDirectedGraph } from "graphology";
import {
  NodeData,
  EdgeData,
  NodeType,
  EdgeType,
  ConfidenceType,
} from "./graph.js";

export interface QueryResultNode {
  id: string;
  name: string;
  type: string;
  file: string;
  line: number;
  metadata?: Record<string, unknown>;
  links?: { incoming: number; outgoing: number };
}

export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface QueryResult {
  target: QueryResultNode;
  incoming: Array<{
    source: QueryResultNode;
    relation: string;
    confidence: string;
  }>;
  outgoing: Array<{
    target: QueryResultNode;
    relation: string;
    confidence: string;
  }>;
  meta: {
    page: number;
    limit: number;
    totalIncoming: number;
    totalOutgoing: number;
    totalPages: number;
  };
}

function normalizeId(id: string): string {
  return id.replace(/\\/g, "/");
}

export function loadGraph(
  targetDir: string,
): MultiDirectedGraph<NodeData, EdgeData> {
  const graphPath = path.join(targetDir, ".geraph", "graph.json");
  if (!fs.existsSync(graphPath)) {
    throw new Error(
      `Graph data not found in ${targetDir}. Run 'geraph scan' first.`,
    );
  }

  const rawData = JSON.parse(fs.readFileSync(graphPath, "utf-8"));
  const graph = new MultiDirectedGraph<NodeData, EdgeData>();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const nodes = (rawData.nodes || []) as Array<Record<string, any>>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const edges = (rawData.edges || []) as Array<Record<string, any>>;

  // Load community mapping from analysis metadata
  const communities = (rawData.analysis?.communities || []) as Array<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Record<string, any>
  >;
  const nodeToCommunity = new Map<string, number>();
  communities.forEach((c) => {
    const members = (c.members || c.nodes || []) as string[];
    members.forEach((nodeId: string) => {
      nodeToCommunity.set(normalizeId(nodeId), Number(c.id));
    });
  });

  nodes.forEach((n) => {
    const nid = normalizeId(n.id as string);
    if (!graph.hasNode(nid)) {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { id, name, type, file, startLine, ...metadata } = n;
      const communityId = nodeToCommunity.get(nid);
      graph.addNode(nid, {
        name: (name as string) || "",
        type: type as NodeType,
        file: normalizeId((file as string) || ""),
        startLine: (startLine as number) || 0,
        metadata: {
          ...(metadata as Record<string, unknown>),
          ...(communityId !== undefined ? { community: communityId } : {}),
        },
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

export interface PaginatedSearchResult {
  data: SearchResultNode[];
  meta: PaginationMeta;
}

export async function searchGraph(
  targetDirOrGraph: string | MultiDirectedGraph<NodeData, EdgeData>,
  term: string,
  targetType?: string,
  page: number = 1,
  limit: number = 20,
): Promise<PaginatedSearchResult> {
  const graph =
    typeof targetDirOrGraph === "string"
      ? loadGraph(targetDirOrGraph)
      : targetDirOrGraph;
  const lowerTerm = term.toLowerCase();

  const results: SearchResultNode[] = [];

  graph.forEachNode((nodeId, attr) => {
    if (targetType && attr.type !== targetType) return;

    // Match if the ID or the Name includes the search term
    if (
      nodeId.toLowerCase().includes(lowerTerm) ||
      (attr.name && attr.name.toLowerCase().includes(lowerTerm))
    ) {
      results.push({
        id: nodeId,
        name: attr.name,
        type: attr.type,
        file: attr.file,
        links: graph.degree(nodeId),
      });
    }
  });

  // Sort by number of connections (most important nodes first)
  results.sort((a, b) => b.links - a.links);

  const total = results.length;
  const totalPages = Math.ceil(total / limit) || 1;
  const start = (page - 1) * limit;
  const end = start + limit;

  return {
    data: results.slice(start, end),
    meta: {
      page,
      limit,
      total,
      totalPages,
    },
  };
}

function resolveTargetNodeId(
  graph: MultiDirectedGraph<NodeData, EdgeData>,
  symbol: string,
  targetType?: string,
  targetSource?: string,
): string {
  const normSymbol = normalizeId(symbol);
  let targetNodeId = graph.hasNode(normSymbol) ? normSymbol : null;

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
    targetNodeId =
      graph.findNode((nodeId, attr) => {
        if (targetType && attr.type !== targetType) return false;
        if (targetSource) {
          const normSource = normalizeId(targetSource);
          if (!attr.file.endsWith(normSource)) return false;
        }
        return (
          (attr && attr.name && attr.name === symbol) ||
          nodeId === normSymbol ||
          nodeId.endsWith("/" + normSymbol) ||
          nodeId.endsWith("::" + normSymbol)
        );
      }) ?? null;
  }

  if (!targetNodeId) {
    targetNodeId =
      graph.findNode((nodeId, attr) => {
        if (targetType && attr.type !== targetType) return false;
        if (targetSource) {
          const normSource = normalizeId(targetSource);
          if (!attr.file.toLowerCase().endsWith(normSource.toLowerCase()))
            return false;
        }
        return (
          (attr &&
            attr.name &&
            attr.name.toLowerCase() === symbol.toLowerCase()) ||
          nodeId.toLowerCase() === normSymbol.toLowerCase() ||
          nodeId.toLowerCase().endsWith("/" + normSymbol.toLowerCase()) ||
          nodeId.toLowerCase().endsWith("::" + normSymbol.toLowerCase())
        );
      }) ?? null;
  }

  if (!targetNodeId) {
    const typeMsg = targetType ? ` of type '${targetType}'` : "";
    const sourceMsg = targetSource ? ` in source '${targetSource}'` : "";
    throw new Error(
      `Symbol '${symbol}'${typeMsg}${sourceMsg} not found in the graph.`,
    );
  }

  return targetNodeId;
}

export async function getNode(
  targetDirOrGraph: string | MultiDirectedGraph<NodeData, EdgeData>,
  symbol: string,
  targetType?: string,
  targetSource?: string,
): Promise<QueryResultNode> {
  const graph =
    typeof targetDirOrGraph === "string"
      ? loadGraph(targetDirOrGraph)
      : targetDirOrGraph;
  const targetNodeId = resolveTargetNodeId(
    graph,
    symbol,
    targetType,
    targetSource,
  );
  const targetAttr = graph.getNodeAttributes(targetNodeId);
  return {
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
  };
}

export async function getNeighbors(
  targetDirOrGraph: string | MultiDirectedGraph<NodeData, EdgeData>,
  symbol: string,
  targetType?: string,
  targetSource?: string,
  page: number = 1,
  limit: number = 20,
): Promise<QueryResult> {
  const graph =
    typeof targetDirOrGraph === "string"
      ? loadGraph(targetDirOrGraph)
      : targetDirOrGraph;

  const targetNodeId = resolveTargetNodeId(
    graph,
    symbol,
    targetType,
    targetSource,
  );

  const targetAttr = graph.getNodeAttributes(targetNodeId);
  const result: QueryResult = {
    target: {
      id: targetNodeId,
      name: targetAttr.name,
      type: targetAttr.type,
      file: targetAttr.file,
      line: targetAttr.startLine,
    },
    incoming: [],
    outgoing: [],
    meta: {
      page,
      limit,
      totalIncoming: 0,
      totalOutgoing: 0,
      totalPages: 1,
    },
  };

  const collectEdges = (
    nodeId: string,
    isOutgoing: boolean,
    seenKeys: Set<string>,
  ) => {
    const iterator = isOutgoing
      ? graph.forEachOutEdge.bind(graph)
      : graph.forEachInEdge.bind(graph);

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
          target: nodeInfo,
        });
      } else {
        result.incoming.push({
          relation: attr.type,
          confidence: attr.confidence,
          source: nodeInfo,
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

  // Sorting Logic: intents first, then degree descending
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sortEdges = (a: any, b: any) => {
    const nodeA = a.source || a.target;
    const nodeB = b.source || b.target;
    if (nodeA.type === "intent" && nodeB.type !== "intent") return -1;
    if (nodeB.type === "intent" && nodeA.type !== "intent") return 1;

    const degreeA = graph.degree(nodeA.id) || 0;
    const degreeB = graph.degree(nodeB.id) || 0;
    return degreeB - degreeA;
  };

  result.incoming.sort(sortEdges);
  result.outgoing.sort(sortEdges);

  const totalIncoming = result.incoming.length;
  const totalOutgoing = result.outgoing.length;
  const maxTotal = Math.max(totalIncoming, totalOutgoing);
  const totalPages = Math.ceil(maxTotal / limit) || 1;

  const start = (page - 1) * limit;
  const end = start + limit;

  result.incoming = result.incoming.slice(start, end);
  result.outgoing = result.outgoing.slice(start, end);

  result.meta = {
    page,
    limit,
    totalIncoming,
    totalOutgoing,
    totalPages,
  };

  return result;
}

function undirectedShortestPath(
  graph: MultiDirectedGraph<NodeData, EdgeData>,
  source: string,
  target: string,
): string[] | null {
  if (source === target) return [source];

  const queue: string[] = [source];
  const visited = new Set<string>([source]);
  const parent = new Map<string, string>();

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === target) break;

    graph.forEachNeighbor(current, (neighbor) => {
      if (!visited.has(neighbor)) {
        visited.add(neighbor);
        parent.set(neighbor, current);
        queue.push(neighbor);
      }
    });
  }

  if (!parent.has(target)) return null;

  const path: string[] = [];
  let curr = target;
  while (curr !== source) {
    path.unshift(curr);
    curr = parent.get(curr)!;
  }
  path.unshift(source);
  return path;
}

export async function shortestPath(
  targetDirOrGraph: string | MultiDirectedGraph<NodeData, EdgeData>,
  sourceSymbol: string,
  targetSymbol: string,
  maxHops: number = 8,
): Promise<string> {
  const graph =
    typeof targetDirOrGraph === "string"
      ? loadGraph(targetDirOrGraph)
      : targetDirOrGraph;

  const normSource = resolveTargetNodeId(graph, sourceSymbol);
  const normTarget = resolveTargetNodeId(graph, targetSymbol);

  if (normSource === normTarget) {
    throw new Error(`Source and target nodes are identical: '${sourceSymbol}'`);
  }

  const path = undirectedShortestPath(graph, normSource, normTarget);

  if (!path) {
    throw new Error("No path exists between the given nodes");
  }

  const hops = path.length - 1;
  if (hops > maxHops) {
    return `Path exceeds max_hops=${maxHops} (${hops} hops found).`;
  }

  const segments: string[] = [];

  for (let i = 0; i < path.length - 1; i++) {
    const u = path[i];
    const v = path[i + 1];

    let forward = true;
    let edgeId: string | undefined;

    if (graph.hasDirectedEdge(u, v)) {
      edgeId = graph.edges(u, v)[0];
    } else if (graph.hasDirectedEdge(v, u)) {
      edgeId = graph.edges(v, u)[0];
      forward = false;
    }

    const edata = edgeId ? graph.getEdgeAttributes(edgeId) : undefined;
    const rel = edata?.type || "";
    const conf = edata?.confidence || "";
    const confStr = conf ? ` [${conf}]` : "";

    const uLabel = String(graph.getNodeAttribute(u, "name") || u);
    const vLabel = String(graph.getNodeAttribute(v, "name") || v);

    if (i === 0) {
      segments.push(uLabel);
    }

    if (forward) {
      segments.push(`--${rel}${confStr}--> ${vLabel}`);
    } else {
      segments.push(`<--${rel}${confStr}-- ${vLabel}`);
    }
  }

  return `Shortest path (${hops} hops):\n  ` + segments.join(" ");
}

export async function getGodNodes(
  targetDirOrGraph: string | MultiDirectedGraph<NodeData, EdgeData>,
  page: number = 1,
  limit: number = 10,
): Promise<string> {
  const graph =
    typeof targetDirOrGraph === "string"
      ? loadGraph(targetDirOrGraph)
      : targetDirOrGraph;
  const { findGodNodes } = await import("./analyze.js");

  const allGods = findGodNodes(graph, graph.order);
  const total = allGods.length;
  const totalPages = Math.ceil(total / limit) || 1;
  const start = (page - 1) * limit;
  const end = start + limit;
  const paginated = allGods.slice(start, end);

  const lines = ["God nodes (most connected):"];
  paginated.forEach((n, idx) => {
    const globalIdx = start + idx + 1;
    lines.push(`  ${globalIdx}. ${n.name} [id: ${n.id}] - ${n.degree} edges`);
  });

  if (totalPages > 1) {
    lines.push(`\n[Page ${page} of ${totalPages} | Total: ${total} nodes]`);
  }
  return lines.join("\n");
}

export async function getCommunityNodes(
  targetDirOrGraph: string | MultiDirectedGraph<NodeData, EdgeData>,
  communityId: number,
  page: number = 1,
  limit: number = 20,
): Promise<string> {
  const graph =
    typeof targetDirOrGraph === "string"
      ? loadGraph(targetDirOrGraph)
      : targetDirOrGraph;
  const { detectCommunities } = await import("./analyze.js");

  const communities = detectCommunities(graph);
  const targetCommunity = communities.find((c) => c.id === communityId);
  if (!targetCommunity) {
    throw new Error(`Community ${communityId} not found.`);
  }

  const total = targetCommunity.nodes.length;
  const totalPages = Math.ceil(total / limit) || 1;
  const start = (page - 1) * limit;
  const end = start + limit;
  const paginatedNodes = targetCommunity.nodes.slice(start, end);

  const lines = [`Community ${communityId} (${total} nodes):`];
  paginatedNodes.forEach((nodeId) => {
    const attr = graph.getNodeAttributes(nodeId);
    const label = attr.name || nodeId;
    const sourceFile = attr.file || "";
    lines.push(`  ${label} [${sourceFile}]`);
  });

  if (totalPages > 1) {
    lines.push(`\n[Page ${page} of ${totalPages} | Total: ${total} nodes]`);
  }
  return lines.join("\n");
}

export async function getSurprisingConnections(
  targetDirOrGraph: string | MultiDirectedGraph<NodeData, EdgeData>,
  page: number = 1,
  limit: number = 20,
): Promise<string> {
  const graph =
    typeof targetDirOrGraph === "string"
      ? loadGraph(targetDirOrGraph)
      : targetDirOrGraph;
  const { detectCommunities, findSurprisingConnections } =
    await import("./analyze.js");

  const communities = detectCommunities(graph);
  const surprises = findSurprisingConnections(graph, communities, graph.size);
  const total = surprises.length;
  const totalPages = Math.ceil(total / limit) || 1;
  const start = (page - 1) * limit;
  const end = start + limit;
  const paginated = surprises.slice(start, end);

  if (total === 0) {
    return "No surprising connections found.";
  }

  const lines = ["Surprising cross-community connections:"];
  paginated.forEach((s) => {
    lines.push(
      `  ${s.sourceName} <-> ${s.targetName} [${s.edgeType}] - ${s.why}`,
    );
  });

  if (totalPages > 1) {
    lines.push(
      `\n[Page ${page} of ${totalPages} | Total: ${total} connections]`,
    );
  }
  return lines.join("\n");
}

function scoreNodes(
  graph: MultiDirectedGraph<NodeData, EdgeData>,
  terms: string[],
): Array<[number, string]> {
  const EXACT_MATCH_BONUS = 1000.0;
  const PREFIX_MATCH_BONUS = 100.0;
  const SUBSTRING_MATCH_BONUS = 1.0;
  const SOURCE_MATCH_BONUS = 0.5;

  const scored: Array<[number, string]> = [];

  graph.forEachNode((nodeId, attr) => {
    const name = (attr.name || "").toLowerCase();
    const source = (attr.file || "").toLowerCase();
    const nidLower = nodeId.toLowerCase();
    let score = 0.0;

    for (const t of terms) {
      if (t === name || t === nidLower) {
        score += EXACT_MATCH_BONUS;
      } else if (name.startsWith(t) || nidLower.startsWith(t)) {
        score += PREFIX_MATCH_BONUS;
      } else if (name.includes(t) || nidLower.includes(t)) {
        score += SUBSTRING_MATCH_BONUS;
      }
      if (source.includes(t)) {
        score += SOURCE_MATCH_BONUS;
      }
    }

    if (score > 0) {
      scored.push([score, nodeId]);
    }
  });

  return scored.sort((a, b) => b[0] - a[0]);
}

export async function queryGraph(
  targetDirOrGraph: string | MultiDirectedGraph<NodeData, EdgeData>,
  symbol: string,
  mode: "bfs" | "dfs" = "bfs",
  depth: number = 3,
  tokenBudget: number = 2000,
): Promise<string> {
  const graph =
    typeof targetDirOrGraph === "string"
      ? loadGraph(targetDirOrGraph)
      : targetDirOrGraph;

  // Extract terms/words from the input string (lowercased, length > 2)
  const terms = symbol
    .split(/\s+/)
    .map((t) => t.replace(/[?,.:;!]/g, "").toLowerCase().trim())
    .filter((t) => t.length > 2);

  let startNodes: string[] = [];

  if (terms.length > 0) {
    const scored = scoreNodes(graph, terms);
    startNodes = scored.slice(0, 3).map((item) => item[1]);
  }

  // Fallback to direct resolution if no matches found through keywords
  if (startNodes.length === 0) {
    try {
      const fallbackId = resolveTargetNodeId(graph, symbol);
      startNodes = [fallbackId];
    } catch {
      throw new Error(`No matching nodes found for query: '${symbol}'`);
    }
  }

  // Compute hub threshold: nodes above this degree are not expanded as transit.
  // p99 of degree distribution, floored at 50 to avoid over-blocking small graphs.
  const degrees: number[] = [];
  graph.forEachNode((nodeId) => {
    degrees.push(graph.degree(nodeId));
  });

  let hubThreshold = 50;
  if (degrees.length > 0) {
    const sorted = [...degrees].sort((a, b) => a - b);
    const p99Idx = Math.floor(sorted.length * 0.99);
    hubThreshold = Math.max(50, sorted[p99Idx] || 50);
  }

  const seedSet = new Set<string>(startNodes);
  const visited = new Set<string>(startNodes);
  const edges: Array<[string, string]> = [];

  if (mode === "bfs") {
    const queue: Array<[string, number]> = startNodes.map((n) => [n, 0]);
    while (queue.length > 0) {
      const [curr, d] = queue.shift()!;
      if (d >= depth) continue;

      // Don't expand through high-degree hubs unless it's one of the starting seed nodes
      if (!seedSet.has(curr) && graph.degree(curr) >= hubThreshold) {
        continue;
      }

      graph.forEachNeighbor(curr, (neighbor) => {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push([neighbor, d + 1]);
        }
        edges.push([curr, neighbor]);
      });
    }
  } else {
    const stack: Array<[string, number]> = [...startNodes].reverse().map((n) => [n, 0]);
    while (stack.length > 0) {
      const [curr, d] = stack.pop()!;
      if (d >= depth) continue;

      if (!seedSet.has(curr) && graph.degree(curr) >= hubThreshold) {
        continue;
      }

      graph.forEachNeighbor(curr, (neighbor) => {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          stack.push([neighbor, d + 1]);
        }
        edges.push([curr, neighbor]);
      });
    }
  }

  const traversedNodes = Array.from(visited);

  // Sort traversed nodes: starting seed nodes first, then others sorted by degree descending
  const remainingNodes = traversedNodes.filter((n) => !seedSet.has(n));
  remainingNodes.sort((a, b) => graph.degree(b) - graph.degree(a));
  const orderedNodes = startNodes.filter((n) => visited.has(n)).concat(remainingNodes);

  const seenEdges = new Set<string>();
  const finalEdges: Array<{ u: string; v: string; rel: string; conf: string }> =
    [];

  edges.forEach(([u, v]) => {
    if (visited.has(u) && visited.has(v)) {
      let edgeId: string | undefined;
      let forward = true;

      if (graph.hasDirectedEdge(u, v)) {
        edgeId = graph.edges(u, v)[0];
      } else if (graph.hasDirectedEdge(v, u)) {
        edgeId = graph.edges(v, u)[0];
        forward = false;
      }

      if (edgeId) {
        const key = forward ? `${u}->${v}` : `${v}->${u}`;
        if (!seenEdges.has(key)) {
          seenEdges.add(key);
          const attr = graph.getEdgeAttributes(edgeId);
          finalEdges.push({
            u: forward ? u : v,
            v: forward ? v : u,
            rel: attr.type || "",
            conf: attr.confidence || "",
          });
        }
      }
    }
  });

  const startNames = startNodes.map(
    (n) => graph.getNodeAttribute(n, "name") || n,
  );
  const header = `Traversal: ${mode.toUpperCase()} depth=${depth} | Start: [${startNames.join(", ")}] | ${orderedNodes.length} nodes found\n\n`;

  const charBudget = tokenBudget * 3;
  const lines: string[] = [];

  orderedNodes.forEach((nid) => {
    const attr = graph.getNodeAttributes(nid);
    const name = attr.name || nid;
    const file = attr.file || "";
    const loc = attr.startLine || 0;
    const community =
      attr.metadata?.community !== undefined ? attr.metadata.community : "";
    lines.push(`NODE ${name} [src=${file} loc=${loc} community=${community}]`);
  });

  finalEdges.forEach(({ u, v, rel, conf }) => {
    const uLabel = graph.getNodeAttribute(u, "name") || u;
    const vLabel = graph.getNodeAttribute(v, "name") || v;
    const confStr = conf ? ` [${conf}]` : "";
    lines.push(`EDGE ${uLabel} --${rel}${confStr}--> ${vLabel}`);
  });

  let output = header + lines.join("\n");
  if (output.length > charBudget) {
    output =
      output.slice(0, charBudget) +
      `\n... (truncated to ~${tokenBudget} token budget)`;
  }

  return output;
}

export async function getGraphStats(
  targetDirOrGraph: string | MultiDirectedGraph<NodeData, EdgeData>
): Promise<string> {
  const graph = typeof targetDirOrGraph === "string" ? loadGraph(targetDirOrGraph) : targetDirOrGraph;
  
  let extractedCount = 0;
  let inferredCount = 0;
  let ambiguousCount = 0;
  
  graph.forEachEdge((edgeId, attr) => {
    if (attr.confidence === "EXTRACTED") extractedCount++;
    else if (attr.confidence === "INFERRED") inferredCount++;
    else if (attr.confidence === "AMBIGUOUS") ambiguousCount++;
  });
  
  const total = graph.size || 1;
  const extPct = Math.round((extractedCount / total) * 100);
  const infPct = Math.round((inferredCount / total) * 100);
  const ambPct = Math.round((ambiguousCount / total) * 100);

  // Get communities count
  let communitiesCount = 0;
  try {
    const { detectCommunities } = await import("./analyze.js");
    communitiesCount = detectCommunities(graph).length;
  } catch {
    // Ignore
  }

  return [
    `Nodes: ${graph.order}`,
    `Edges: ${graph.size}`,
    `Communities: ${communitiesCount}`,
    `EXTRACTED: ${extPct}%`,
    `INFERRED: ${infPct}%`,
    `AMBIGUOUS: ${ambPct}%`
  ].join("\n");
}
