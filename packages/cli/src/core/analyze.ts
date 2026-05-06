/**
 * Graph Analysis Engine
 *
 * Computes structural metrics on the Knowledge Graph:
 * - God Nodes:  highest-degree real entities (the architectural pillars)
 * - Community Detection:  Louvain clustering to group related nodes
 * - Surprising Connections:  edges that bridge different communities
 * - Cohesion Scores:  density ratio per community
 */

import { MultiDirectedGraph } from "graphology";
import louvain from "graphology-communities-louvain";
import type { NodeData, EdgeData } from "./graph.js";

type LouvainAlgorithm = (graph: MultiDirectedGraph<NodeData, EdgeData>) => Record<string, number>;
const louvainAlgorithm = louvain as unknown as LouvainAlgorithm;

export interface GodNode {
  id: string;
  name: string;
  type: string;
  degree: number;
}

export interface Community {
  id: number;
  nodes: string[];
  cohesion: number;
}

export interface SurprisingConnection {
  source: string;
  sourceName: string;
  target: string;
  targetName: string;
  edgeType: string;
  confidence: string;
  sourceCommunity: number;
  targetCommunity: number;
  why: string;
}

export interface AnalysisResult {
  godNodes: GodNode[];
  communities: Community[];
  surprisingConnections: SurprisingConnection[];
  nodeCount: number;
  edgeCount: number;
}

/** Nodes that should be excluded from god-node / surprise rankings. */
function isStructuralNoise(
  graph: MultiDirectedGraph<NodeData, EdgeData>,
  nodeId: string,
): boolean {
  const data = graph.getNodeAttributes(nodeId);
  // Commit nodes are metadata, not architecture
  if (data.type === "intent") return true;
  // External imports
  if (nodeId.startsWith("import::")) return true;
  // Unresolved ghost nodes
  if (nodeId.startsWith("unresolved_")) return true;
  return false;
}

/**
 * Returns the top-N most-connected real entities, excluding structural noise.
 * These are the architectural pillars of the codebase — if you change them,
 * the ripple effect is enormous.
 */
export function findGodNodes(
  graph: MultiDirectedGraph<NodeData, EdgeData>,
  topN = 10,
): GodNode[] {
  const ranked: GodNode[] = [];

  graph.forEachNode((nodeId, data) => {
    if (isStructuralNoise(graph, nodeId)) return;
    ranked.push({
      id: nodeId,
      name: data.name,
      type: data.type,
      degree: graph.degree(nodeId),
    });
  });

  ranked.sort((a, b) => b.degree - a.degree);
  return ranked.slice(0, topN);
}

/**
 * Runs Louvain community detection on the graph and returns communities
 * sorted by size (largest first), each with a cohesion score.
 *
 * Louvain requires an undirected simple graph, so we convert internally.
 */
export function detectCommunities(
  graph: MultiDirectedGraph<NodeData, EdgeData>,
): Community[] {
  if (graph.order === 0) return [];

  let communityMap: Record<string, number> = {};

  try {
    communityMap = louvainAlgorithm(graph);
  } catch {
    graph.forEachNode((nodeId) => {
      communityMap[nodeId] = 0;
    });
  }

  const groups = new Map<number, string[]>();
  for (const [nodeId, cid] of Object.entries(communityMap)) {
    if (!groups.has(cid)) groups.set(cid, []);
    groups.get(cid)!.push(nodeId);
  }

  const communities: Community[] = [];
  for (const [cid, nodes] of groups.entries()) {
    communities.push({
      id: cid,
      nodes,
      cohesion: cohesionScore(graph, nodes),
    });
  }

  communities.sort((a, b) => b.nodes.length - a.nodes.length);
  return communities;
}

/**
 * Ratio of actual intra-community edges to maximum possible.
 * 1.0 = fully connected clique, 0.0 = no internal edges.
 */
function cohesionScore(
  graph: MultiDirectedGraph<NodeData, EdgeData>,
  communityNodes: string[],
): number {
  const n = communityNodes.length;
  if (n <= 1) return 1.0;

  const nodeSet = new Set(communityNodes);
  let internalEdges = 0;

  graph.forEachEdge((_edgeId, _data, source, target) => {
    if (nodeSet.has(source) && nodeSet.has(target)) {
      internalEdges++;
    }
  });

  const possible = n * (n - 1); // directed pairs
  return possible > 0 ? Math.round((internalEdges / possible) * 100) / 100 : 0;
}

/**
 * Finds edges that bridge different communities — the "non-obvious" couplings.
 * These are architecturally significant because they link parts of the codebase
 * that are otherwise completely independent.
 */
export function findSurprisingConnections(
  graph: MultiDirectedGraph<NodeData, EdgeData>,
  communities: Community[],
  topN = 5,
): SurprisingConnection[] {
  // Build node → community map
  const nodeCommunity = new Map<string, number>();
  for (const comm of communities) {
    for (const nodeId of comm.nodes) {
      nodeCommunity.set(nodeId, comm.id);
    }
  }

  const candidates: (SurprisingConnection & { _score: number })[] = [];

  graph.forEachEdge((_edgeId, edgeData, source, target) => {
    const srcComm = nodeCommunity.get(source);
    const tgtComm = nodeCommunity.get(target);

    // Skip same-community or unknown community
    if (srcComm === undefined || tgtComm === undefined) return;
    if (srcComm === tgtComm) return;

    // Skip structural noise
    if (isStructuralNoise(graph, source) || isStructuralNoise(graph, target))
      return;

    // Skip pure structural edges (imports, defines)
    if (edgeData.type === "imports" || edgeData.type === "defines") return;

    const srcData = graph.getNodeAttributes(source);
    const tgtData = graph.getNodeAttributes(target);

    // Score the surprise
    let score = 1;
    const reasons: string[] = [];

    // Cross-community = base surprise
    reasons.push(`bridges community ${srcComm} → community ${tgtComm}`);

    // Non-obvious edge types are more surprising
    if (
      edgeData.type === "references" ||
      edgeData.type === "extends" ||
      edgeData.type === "implements"
    ) {
      score += 2;
      reasons.push(`${edgeData.type} relationship (deep OOP coupling)`);
    }

    // Peripheral → hub: low-degree node talking to high-degree one
    const srcDeg = graph.degree(source);
    const tgtDeg = graph.degree(target);
    if (Math.min(srcDeg, tgtDeg) <= 2 && Math.max(srcDeg, tgtDeg) >= 5) {
      score += 1;
      const peripheral =
        srcDeg <= 2 ? srcData.name : tgtData.name;
      const hub = srcDeg <= 2 ? tgtData.name : srcData.name;
      reasons.push(
        `peripheral node "${peripheral}" unexpectedly reaches hub "${hub}"`,
      );
    }

    // INFERRED/AMBIGUOUS edges are more noteworthy
    if (edgeData.confidence === "AMBIGUOUS") {
      score += 3;
      reasons.push("ambiguous connection — needs verification");
    } else if (edgeData.confidence === "INFERRED") {
      score += 2;
      reasons.push("inferred connection — not explicitly stated in source");
    }

    candidates.push({
      source,
      sourceName: srcData.name,
      target,
      targetName: tgtData.name,
      edgeType: edgeData.type,
      confidence: edgeData.confidence,
      sourceCommunity: srcComm,
      targetCommunity: tgtComm,
      why: reasons.join("; "),
      _score: score,
    });
  });

  // Sort by surprise score descending
  candidates.sort((a, b) => b._score - a._score);

  // Deduplicate by community pair (at most 1 representative per boundary)
  const seenPairs = new Set<string>();
  const results: SurprisingConnection[] = [];

  for (const c of candidates) {
    const pair = [c.sourceCommunity, c.targetCommunity].sort().join("-");
    if (seenPairs.has(pair)) continue;
    seenPairs.add(pair);
    // Strip internal scoring field
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { _score, ...connection } = c;
    results.push(connection);
    if (results.length >= topN) break;
  }

  return results;
}

export interface AnalysisResult {
  godNodes: GodNode[];
  communities: Community[];
  surprisingConnections: SurprisingConnection[];
  nodeCount: number;
  edgeCount: number;
  knowledgeGaps: string[];
  suggestedQuestions: string[];
}

/**
 * Runs the full analysis pipeline: God Nodes → Communities → Surprises.
 */
export function analyzeGraph(
  graph: MultiDirectedGraph<NodeData, EdgeData>,
): AnalysisResult {
  const godNodes = findGodNodes(graph);
  const communities = detectCommunities(graph);
  const surprisingConnections = findSurprisingConnections(
    graph,
    communities,
  );

  // Detect Knowledge Gaps: Nodes with degree 0 or 1 that aren't structural noise
  const knowledgeGaps: string[] = [];
  graph.forEachNode((nodeId) => {
    if (graph.degree(nodeId) <= 1 && !isStructuralNoise(graph, nodeId)) {
      knowledgeGaps.push(nodeId);
    }
  });

  // Generate Suggested Questions
  const questions: string[] = [];
  if (surprisingConnections.length > 0) {
    questions.push("Why are these distinct communities connected via Surprising Connections?");
  }
  if (godNodes.length > 0) {
    questions.push(`How would the system react if the core logic in '${godNodes[0]?.name}' was refactored?`);
  }
  if (knowledgeGaps.length > 5) {
    questions.push("There are several isolated modules; are these dead code or missing integration tests?");
  }
  if (communities.length > 1) {
    questions.push("Are the boundaries between these communities enforced, or is there hidden leakage?");
  }

  return {
    godNodes,
    communities,
    surprisingConnections,
    nodeCount: graph.order,
    edgeCount: graph.size,
    knowledgeGaps: knowledgeGaps.slice(0, 10), // Limit to top 10
    suggestedQuestions: questions,
  };
}

