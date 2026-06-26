import fs from "fs";
import path from "path";
import type { MultiDirectedGraph } from "graphology";
import type { NodeData, EdgeData, NodeType } from "./graph.js";
import type { AnalysisResult } from "./analyze.js";

/**
 * Compresses and serializes the Graphology instance into a clean JSON structure
 * suitable for LLM injection ("Caveman Mode").
 */
export function exportGraphJson(
  graph: MultiDirectedGraph<NodeData, EdgeData>,
  outDir: string,
  analysis?: AnalysisResult,
) {
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  const nodes = graph.nodes().map((nodeId) => {
    const data = graph.getNodeAttributes(nodeId);
    return {
      id: nodeId,
      type: data.type,
      name: data.name,
      file: data.file,
      startLine: data.startLine,
      ...data.metadata,
    };
  });

  const edges = graph.edges().map((edgeId) => {
    const source = graph.source(edgeId);
    const target = graph.target(edgeId);
    const data = graph.getEdgeAttributes(edgeId);
    return {
      source,
      target,
      relation: data.type,
      confidence: data.confidence,
      ...data.metadata,
    };
  });

  const payload: Record<string, unknown> = {
    version: "1.0.0",
    nodes,
    edges,
  };

  if (analysis) {
    payload.analysis = {
      godNodes: analysis.godNodes,
      communities: analysis.communities.map((c) => ({
        id: c.id,
        nodeCount: c.nodes.length,
        cohesion: c.cohesion,
        members: c.nodes,
      })),
      surprisingConnections: analysis.surprisingConnections,
    };
  }

  const jsonPath = path.join(outDir, "graph.json");
  fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2), "utf-8");

  return jsonPath;
}

/**
 * Generates a token-efficient plain-language Markdown report.
 * This is an LLM-friendly overview of the codebase architecture and history.
 */
export function exportReportMarkdown(
  graph: MultiDirectedGraph<NodeData, EdgeData>,
  outDir: string,
  analysis?: AnalysisResult,
) {
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  let md = `# Geraph Codebase Report\n\n`;

  // Section 1: Architecture (Files and Functions)
  md += `## Architecture Structure\n`;
  md += `*Note: Only the first 100 files and their primary members are listed here. For full data, use the \`search_graph\` or \`query_graph\` MCP tools (recommended) or corresponding CLI commands.*\n\n`;

  const allFileNodes = graph
    .nodes()
    .filter((n) => graph.getNodeAttribute(n, "type") === "file");
  const fileNodes = allFileNodes.slice(0, 100);

  for (const file of fileNodes) {
    const data = graph.getNodeAttributes(file);
    if (data.metadata?.external) continue;

    md += `- **${data.name}** [id: \`${file}\`]\n`;

    // Find classes and functions defined in this file
    const definesEdges = graph.outEdges(file).filter((edgeId) => {
      return graph.getEdgeAttribute(edgeId, "type") === "defines";
    });

    // Limit to 5 members per file in the report to save tokens
    const membersToShow = definesEdges.slice(0, 5);
    for (const edgeId of membersToShow) {
      const target = graph.target(edgeId);
      const targetData = graph.getNodeAttributes(target);
      md += `  - \`${targetData.type} ${targetData.name}\` [id: \`${target}\`]\n`;
    }
    if (definesEdges.length > 5) {
      md += `  - ... and ${definesEdges.length - 5} more\n`;
    }
  }

  if (allFileNodes.length > 100) {
    md += `\n- *... and ${allFileNodes.length - 100} more file nodes. Use \`search_graph\` or \`query_graph\` MCP tools (recommended) to explore them.*\n`;
  }

  // Section 2: God Nodes
  if (analysis && analysis.godNodes.length > 0) {
    const realNodesCount = graph.nodes().filter(n => {
      const type = graph.getNodeAttribute(n, "type");
      return type !== "intent" && !n.startsWith("import::") && !n.startsWith("unresolved_");
    }).length;

    const title = realNodesCount > 10 ? "Top 10 God Nodes (Architectural Pillars)" : "God Nodes (Architectural Pillars)";
    md += `\n## ${title}\n`;
    md += `These are the most-connected entities in the codebase. Changes to these nodes have the largest ripple effect. For full data, use the \`god_nodes\` MCP tool (recommended) or \`geraph god\` CLI command.\n\n`;
    
    const godsToShow = analysis.godNodes.slice(0, 10);
    for (const god of godsToShow) {
      md += `- **${god.name}** (type: \`${god.type}\`, id: \`${god.id}\`, ${god.degree} connections)\n`;
    }
  }

  // Section 3: Communities
  if (analysis && analysis.communities.length > 0) {
    md += `\n## Communities\n`;
    md += `The codebase clusters into ${analysis.communities.length} communities of related code. For full community membership, use the \`get_community\` MCP tool (recommended) or \`geraph community <id>\` CLI command.\n\n`;
    for (const comm of analysis.communities) {
      const realNodes = comm.nodes.filter(
        (n) => !n.startsWith("commit::") && !n.startsWith("import::") && !n.startsWith("unresolved_") && graph.hasNode(n)
      );
      // Sort by degree descending to show the most connected community members first
      realNodes.sort((a, b) => graph.degree(b) - graph.degree(a));

      const top5 = realNodes.slice(0, 5);
      const memberStrings = top5.map((n) => {
        const data = graph.getNodeAttributes(n);
        const name = data ? data.name : n;
        return `**${name}** [id: \`${n}\`]`;
      });

      let communityLine = `- **Community (ID: \`${comm.id}\`)** (${comm.nodes.length} nodes, cohesion: ${comm.cohesion}) — ${memberStrings.join(", ")}`;
      if (realNodes.length > 5) {
        communityLine += `, and ${realNodes.length - 5} more.`;
      }
      communityLine += `\n  *(To view all members: run \`geraph community ${comm.id}\` or use the \`get_community\` MCP tool with community_id=${comm.id})*\n`;
      md += communityLine;
    }
  }

  // Section 4: Surprising Connections
  if (analysis && analysis.surprisingConnections.length > 0) {
    const totalSurprises = analysis.surprisingConnections.length;
    const title = totalSurprises > 10 ? "Top 10 Surprising Connections" : "Surprising Connections";
    md += `\n## ${title}\n`;
    md += `Non-obvious couplings that bridge different parts of the architecture. For full data, use the \`get_surprises\` MCP tool (recommended) or \`geraph surprises\` CLI command.\n\n`;
    
    const surprisesToShow = analysis.surprisingConnections.slice(0, 10);
    for (const s of surprisesToShow) {
      md += `- **${s.sourceName}** [id: \`${s.source}\`] ↔ **${s.targetName}** [id: \`${s.target}\`] (\`${s.edgeType}\`): ${s.why}\n`;
    }
  }

  // Section 5: Knowledge Gaps
  if (analysis && analysis.knowledgeGaps && analysis.knowledgeGaps.length > 0) {
    md += `\n## Knowledge Gaps\n`;
    md += `These are isolated or nearly-isolated entities that may be missing documentation or architectural integration.\n\n`;
    for (const gap of analysis.knowledgeGaps) {
      const data = graph.getNodeAttributes(gap);
      md += `- \`${data.type} ${data.name}\` (isolated in ${path.basename(gap.split("::")[0] || gap)})\n`;
    }
  }

  // Section 6: Suggested Questions for AI
  if (analysis && analysis.suggestedQuestions && analysis.suggestedQuestions.length > 0) {
    md += `\n## Suggested Questions for AI\n`;
    md += `_Questions this graph is uniquely positioned to answer:_\n\n`;
    for (const q of analysis.suggestedQuestions) {
      md += `- **${q}**\n`;
    }
  }

  md += `\n---\n*Generated by Geraph at ${new Date().toISOString()}*\n`;

  // Section 5: Temporal Facts (Intent)
  // Sort by date (descending) and limit to top 50
  const intentNodes = graph
    .nodes()
    .filter((n) => graph.getNodeAttribute(n, "type") === "intent")
    .sort((a, b) => {
      const metaA = graph.getNodeAttribute(a, "metadata") as Record<string, unknown>;
      const metaB = graph.getNodeAttribute(b, "metadata") as Record<string, unknown>;
      const dateA = (metaA?.date as string) || "";
      const dateB = (metaB?.date as string) || "";
      return dateB.localeCompare(dateA);
    })
    .slice(0, 50);

  if (intentNodes.length > 0) {
    md += `\n## Recent Architectural Changes & Intent\n`;
    md += `*Showing the 50 most recent architectural commits. Use 'query' on a specific symbol to see its full history.*\n\n`;
    for (const intent of intentNodes) {
      const data = graph.getNodeAttributes(intent);
      const msg = (data.metadata?.message || "").split("\n")[0]; // Only first line of message
      md += `- **${data.name}**: ${msg}\n`;
    }
  }

  const mdPath = path.join(outDir, "GRAPH_REPORT.md");
  fs.writeFileSync(mdPath, md, "utf-8");

  return mdPath;
}

/**
 * Generates a standalone interactive HTML visualization of the knowledge graph
 * using force-graph. No build step required, opens directly in any browser.
 */
export function exportGraphHtml(
  graph: MultiDirectedGraph<NodeData, EdgeData>,
  outDir: string,
  analysis?: AnalysisResult,
) {
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  const counts: Record<string, number> = {
    file: 0,
    media: 0,
    class: 0,
    function: 0,
    intent: 0,
    type: 0,
    interface: 0,
    enum: 0,
    struct: 0,
    trait: 0,
    macro: 0,
  };

  // Calculate node degrees for sizing and label logic
  const nodeDegrees = new Map<string, number>();
  graph.nodes().forEach((n) => {
    nodeDegrees.set(n, graph.degree(n));
  });

  // Sort nodes by degree to find the top 50 hubs
  const sortedByDegree = [...graph.nodes()].sort(
    (a, b) => (nodeDegrees.get(b) || 0) - (nodeDegrees.get(a) || 0),
  );
  const topHubs = new Set(sortedByDegree.slice(0, 50));
  const maxDegree = Math.max(...Array.from(nodeDegrees.values()), 1);

  const COLORS: Record<NodeType, string> & { default: string } = {
    default: "#64748b",
    file: "#479af3ff",
    class: "#F28E2B",
    function: "#ee272bff",
    intent: "#35d86eff",
    media: "#843b11ff",
    type: "#B07AA1",
    interface: "#e134b0ff",
    enum: "#59A14F",
    struct: "#E15759",
    trait: "#76B7B2",
    macro: "#EDC948",
  };

  const nodeCommunities = new Map<string, string>();
  if (analysis) {
    analysis.communities.forEach((comm) => {
      comm.nodes.forEach((nodeId) => {
        nodeCommunities.set(nodeId, String(comm.id));
      });
    });
  }

  const RAW_COMMUNITIES = analysis ? analysis.communities.map((c, idx) => {
    const hue = (idx * 137.5) % 360;
    const color = `hsl(${hue}, 70%, 50%)`;
    return {
      id: String(c.id),
      name: `Community ${c.id}`,
      nodeCount: c.nodes.length,
      cohesion: c.cohesion,
      color: color,
      members: c.nodes
    };
  }) : [];

  const RAW_NODES = graph.nodes().map((n) => {
    const data = graph.getNodeAttributes(n);
    const degree = nodeDegrees.get(n) || 0;

    const scaledSize = 10 + 30 * (degree / maxDegree);

    const color = COLORS[data.type] ?? COLORS.default;

    if (data.type && counts[data.type] !== undefined) {
      counts[data.type] = (counts[data.type] || 0) + 1;
    }

    // Label Logic: Show all if <= 50 nodes, otherwise only top 50 hubs
    const showLabel = graph.order <= 50 || topHubs.has(n);
    const fontSize = showLabel ? 12 : 0;

    let sourceFile = "";
    if (n.includes("::")) {
      sourceFile = n.split("::")[0] as string;
    } else if (data.type === "file") {
      sourceFile = n;
    }

    return {
      id: n,
      label: data.name || n,
      title: data.name || n,
      color: {
        background: color,
        border: color,
        highlight: { background: "#ffffff", border: color },
        hover: { background: color, border: "#ffffff" },
      },
      size: scaledSize,
      font: {
        size: fontSize,
        color: "#ffffff",
        strokeWidth: 2,
        strokeColor: "#0f0f1a",
      },
      node_type: data.type,
      source_file: sourceFile,
      degree: degree,
      startLine: data.startLine,
      community: nodeCommunities.get(n) ?? "none",
      ...data.metadata,
    };
  });

  const RAW_EDGES = graph.edges().map((id) => {
    const attr = graph.getEdgeAttributes(id);
    return {
      from: graph.source(id),
      to: graph.target(id),
      relation: attr.type,
      confidence: attr.confidence,
      color: { color: "rgba(255,255,255,0.15)", highlight: "#ffffff" },
      arrows: { to: { enabled: true, scaleFactor: 0.5 } },
      smooth: { type: "continuous", roundness: 0.2 },
      width: 1,
    };
  });

  const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Geraph Knowledge Graph</title>
  <script type="text/javascript" src="https://unpkg.com/vis-network/standalone/umd/vis-network.min.js"></script>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600&display=swap" rel="stylesheet">
  <style>
    body, html {
      margin: 0; padding: 0; width: 100%; height: 100%;
      background: #0f0f1a; color: #fff; overflow: hidden;
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    #container { width: 100%; height: 100%; }
    
    #loading-overlay {
      position: absolute; inset: 0; background: #0f0f1a;
      display: flex; align-items: center; justify-content: center;
      z-index: 200; font-size: 1rem; color: #3b82f6;
      transition: opacity 0.5s ease;
    }

    #sidebar {
      position: absolute; left: 20px; top: 20px; bottom: 20px;
      width: 320px; background: rgb(12.941% 12.941% 12.941%);
      border-radius: 30px;
      display: flex; flex-direction: column; z-index: 100;
    }
    #sidebar-header { padding: 20px; border-bottom: 1px solid rgba(255,255,255,0.1); }
    #sidebar-header h1 { margin: 0; font-size: 1.2rem; color: #fff; }
    #sidebar-header p { margin: 5px 0 0; font-size: 0.8rem; color: #888; }
    
    #search-box { padding: 15px; position: relative; }
    #search {
      width: 100%; padding: 10px; background: rgb(17.255% 17.255% 17.255%);
      border: none; border-radius: 15px;
      color: #fff; box-sizing: border-box; font-family: inherit;
    }
    #search-suggestions {
      position: absolute;
      left: 15px;
      right: 15px;
      top: calc(100% - 5px);
      background: rgb(17.255% 17.255% 17.255%);
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 15px;
      max-height: 250px;
      overflow-y: auto;
      z-index: 150;
      box-shadow: 0 10px 30px rgba(0,0,0,0.6);
      scrollbar-width: thin;
      scrollbar-color: rgba(255,255,255,0.1) transparent;
    }
    .suggestion-item {
      padding: 10px 14px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px solid rgba(255, 255, 255, 0.05);
      transition: background 0.15s ease;
      font-size: 0.85rem;
    }
    .suggestion-item:last-child {
      border-bottom: none;
    }
    .suggestion-item:hover, .suggestion-item.active {
      background: rgba(83, 83, 83, 0.25);
    }
    .suggestion-name {
      color: #fff;
      font-weight: 500;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 190px;
    }
    .suggestion-type {
      font-size: 0.65rem;
      font-weight: 600;
      color: #b8b8b8;
      text-transform: uppercase;
      background: rgba(255, 255, 255, 0.08);
      padding: 2px 6px;
      border-radius: 4px;
    }
    
    #info-panel { flex: 1; padding: 20px; overflow-y: auto; font-size: 0.9rem; scrollbar-color: rgba(255,255,255,0.1) transparent; scrollbar-width: thin }
    #info-panel h3 { margin-top: 0; font-size: 1rem; color: #3b82f6; }
    #info-content { word-break: break-word; }
    .field { margin-bottom: 12px; }
    .field b { color: #888; display: block; font-size: 0.75rem; text-transform: uppercase; margin-bottom: 2px; }
    .empty { color: #555; font-style: italic; }
    
    #legend { padding: 20px; border-top: 1px solid rgba(255,255,255,0.1); display: flex; flex-direction: column; gap: 0.3rem; max-height: 100px; overflow-y: auto; scrollbar-color: rgba(255,255,255,0.1) transparent; scrollbar-width: thin }
    .legend-item { display: flex; align-items: center; justify-content: space-between; font-size: 0.8rem; cursor: pointer; transition: opacity 0.2s; user-select: none; }
    .legend-item:hover { opacity: 0.8; }
    .legend-item.inactive { opacity: 0.35; }
    .legend-item-left { display: flex; align-items: center; }
    .legend-dot { width: 10px; height: 10px; border-radius: 50%; margin-right: 10px; }
    .legend-count { color: #666; font-weight: 600; }
    #stats-container {
      border-top: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 0 0 30px 30px;
    }
    #view-tabs {
      display: flex;
      width: 100%;
    }
    #view-tabs.no-communities button[data-mode="communities"] {
      display: none;
    }
    #view-tabs.no-communities button[data-mode="types"] {
      width: 100%;
      cursor: default;
      background: transparent;
      border-radius: 0 0 30px 30px;
    }
    .tab-btn {
      flex: 1;
      background: transparent;
      border: none;
      color: #666;
      padding: 12px 10px;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.2s, color 0.2s;
      outline: none;
      text-align: center;
      border-right: 1px solid rgba(255, 255, 255, 0.05);
    }
    .tab-btn:last-child {
      border-right: none;
      border-radius: 0 0 30px 0px !important;
    }
    .tab-btn.active {
      background: rgba(255, 255, 255, 0.05);
      color: #fff;
      border-radius: 0 0 0px 30px;
    }
    .tab-btn:hover:not(.active) {
      background: rgba(255, 255, 255, 0.02);
      color: #aaa;
      border-radius: 0 0 0px 30px;
    }
    .neighbors-section {
      margin-top: 15px;
      border-top: 1px solid rgba(255, 255, 255, 0.1);
      padding-top: 12px;
    }
    .neighbors-header {
      font-size: 0.8rem;
      font-weight: 600;
      color: #888;
      text-transform: uppercase;
      margin-bottom: 8px;
      letter-spacing: 0.5px;
    }
    .neighbor-list {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .neighbor-item {
      padding: 6px 10px;
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid rgba(255, 255, 255, 0.05);
      border-radius: 4px;
      cursor: pointer;
      display: flex;
      flex-direction: column;
      transition: background 0.2s, border-color 0.2s;
    }
    .neighbor-item:hover {
      background: rgba(168, 168, 168, 0.15);
      border-color: rgba(146, 146, 146, 0.3);
    }
    .neighbor-meta {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 0.7rem;
      margin-bottom: 3px;
    }
    .neighbor-relation {
      color: #3b82f6;
      font-weight: 600;
      text-transform: uppercase;
    }
    .neighbor-confidence {
      color: #888;
      background: rgba(255, 255, 255, 0.05);
      padding: 1px 4px;
      border-radius: 3px;
    }
    .neighbor-main {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 0.8rem;
    }
    .neighbor-main-left {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .neighbor-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .neighbor-name {
      color: #fff;
      font-weight: 500;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 180px;
    }
    .neighbor-type {
      font-size: 0.65rem;
      color: #888;
      text-transform: uppercase;
      white-space: nowrap;
    }
    .show-more-btn {
      background: none;
      border: none;
      color: #3b82f6;
      cursor: pointer;
      font-size: 0.75rem;
      font-weight: 600;
      padding: 6px 0;
      text-align: left;
      transition: color 0.2s;
      outline: none;
      width: 100%;
    }
    .show-more-btn:hover {
      color: #60a5fa;
    }
    .hidden { display: none !important; }
  </style>
</head>
<body>
  <div id="loading-overlay">Loading Knowledge Graph...</div>
  <div id="sidebar">
    <div id="sidebar-header">
      <h1>Geraph Map</h1>
      <p>Codebase Knowledge Graph</p>
    </div>
    <div id="search-box">
      <input type="text" id="search" placeholder="Search nodes..." autocomplete="off">
      <div id="search-suggestions" class="hidden"></div>
    </div>
    <div id="info-panel">
      <div id="info-content">
        <span class="empty">Select a node to view its properties</span>
      </div>
    </div>
    <div id="legend">
      <div class="legend-item ${counts.file ? "" : "hidden"}" data-type="file"><div class="legend-item-left"><div class="legend-dot" style="background: ${COLORS.file};"></div> File</div><span class="legend-count">${counts.file || 0}</span></div>
      <div class="legend-item ${counts.media ? "" : "hidden"}" data-type="media"><div class="legend-item-left"><div class="legend-dot" style="background: ${COLORS.media};"></div> Media</div><span class="legend-count">${counts.media || 0}</span></div>
      <div class="legend-item ${counts.class ? "" : "hidden"}" data-type="class"><div class="legend-item-left"><div class="legend-dot" style="background: ${COLORS.class};"></div> Class</div><span class="legend-count">${counts.class || 0}</span></div>
      <div class="legend-item ${counts.struct ? "" : "hidden"}" data-type="struct"><div class="legend-item-left"><div class="legend-dot" style="background: ${COLORS.struct};"></div> Struct</div><span class="legend-count">${counts.struct || 0}</span></div>
      <div class="legend-item ${counts.trait ? "" : "hidden"}" data-type="trait"><div class="legend-item-left"><div class="legend-dot" style="background: ${COLORS.trait};"></div> Trait</div><span class="legend-count">${counts.trait || 0}</span></div>
      <div class="legend-item ${counts.macro ? "" : "hidden"}" data-type="macro"><div class="legend-item-left"><div class="legend-dot" style="background: ${COLORS.macro};"></div> Macro</div><span class="legend-count">${counts.macro || 0}</span></div>
      <div class="legend-item ${counts.function ? "" : "hidden"}" data-type="function"><div class="legend-item-left"><div class="legend-dot" style="background: ${COLORS.function};"></div> Function</div><span class="legend-count">${counts.function || 0}</span></div>
      <div class="legend-item ${counts.type || counts.interface ? "" : "hidden"}" data-type="type,interface"><div class="legend-item-left"><div class="legend-dot" style="background: ${COLORS.type};"></div> Type/Interface</div><span class="legend-count">${(counts.type || 0) + (counts.interface || 0)}</span></div>
      <div class="legend-item ${counts.enum ? "" : "hidden"}" data-type="enum"><div class="legend-item-left"><div class="legend-dot" style="background: ${COLORS.enum};"></div> Enum</div><span class="legend-count">${counts.enum || 0}</span></div>
      <div class="legend-item ${counts.intent ? "" : "hidden"}" data-type="intent"><div class="legend-item-left"><div class="legend-dot" style="background: ${COLORS.intent};"></div> Intent</div><span class="legend-count">${counts.intent || 0}</span></div>
    </div>
    <div id="stats-container">
      <div id="view-tabs" class="${RAW_COMMUNITIES.length > 0 ? '' : 'no-communities'}">
        <button class="tab-btn active" data-mode="types">${RAW_NODES.length} nodes &middot; ${RAW_EDGES.length} edges</button>
        <button class="tab-btn" data-mode="communities">${RAW_COMMUNITIES.length} communities</button>
      </div>
    </div>
  </div>
  <div id="container"></div>

<script type="text/javascript">
  const RAW_NODES = ${JSON.stringify(RAW_NODES)};
  const RAW_EDGES = ${JSON.stringify(RAW_EDGES)};
  const RAW_COMMUNITIES = ${JSON.stringify(RAW_COMMUNITIES)};

  function escapeHtmlAttr(str) {
    return (str || '').replace(/"/g, '&quot;');
  }

  const hiddenNodeTypes = new Set();
  const hiddenCommunities = new Set();
  let currentViewMode = 'types';
  const legendTypesHtml = document.getElementById('legend') ? document.getElementById('legend').innerHTML : '';

  function renderLegend(mode) {
    const legendContainer = document.getElementById('legend');
    if (!legendContainer) return;

    if (mode === 'types') {
      legendContainer.innerHTML = legendTypesHtml;
      const items = legendContainer.querySelectorAll('.legend-item');
      items.forEach(item => {
        const typesStr = item.getAttribute('data-type');
        if (typesStr) {
          const types = typesStr.split(',');
          if (hiddenNodeTypes.has(types[0])) {
            item.classList.add('inactive');
          } else {
            item.classList.remove('inactive');
          }
        }
      });
    } else {
      const sortedCommunities = [...RAW_COMMUNITIES].sort((a, b) => parseInt(a.id) - parseInt(b.id));
      legendContainer.innerHTML = sortedCommunities.map(comm => {
        const isInactive = hiddenCommunities.has(comm.id) ? 'inactive' : '';
        return \`<div class="legend-item \${isInactive}" data-community="\${comm.id}">
          <div class="legend-item-left">
            <div class="legend-dot" style="background: \${comm.color};"></div>
            \${comm.name}
          </div>
          <span class="legend-count">\${comm.nodeCount}</span>
        </div>\`;
      }).join('');
    }
  }

  function switchViewMode(mode) {
    currentViewMode = mode;
    
    const tabs = document.querySelectorAll('.tab-btn');
    tabs.forEach(t => {
      if (t.getAttribute('data-mode') === mode) {
        t.classList.add('active');
      } else {
        t.classList.remove('active');
      }
    });

    const updates = [];
    for (const n of RAW_NODES) {
      let color;
      if (mode === 'communities') {
        const comm = RAW_COMMUNITIES.find(c => c.id === n.community);
        color = comm ? comm.color : '#64748b';
      } else {
        color = n.color.background;
      }
      updates.push({
        id: n.id,
        color: {
          background: color,
          border: color,
          highlight: { background: '#ffffff', border: color },
          hover: { background: color, border: '#ffffff' }
        }
      });
    }
    nodes.update(updates);

    renderLegend(mode);
  }

  const viewTabsEl = document.getElementById('view-tabs');
  if (viewTabsEl) {
    viewTabsEl.addEventListener('click', (e) => {
      const btn = e.target.closest('.tab-btn');
      if (btn) {
        const mode = btn.getAttribute('data-mode');
        if (mode && mode !== currentViewMode) {
          switchViewMode(mode);
        }
      }
    });
  }

  function renderNeighborItem(edge, direction) {
    const neighborId = direction === 'outgoing' ? edge.to : edge.from;
    const neighbor = RAW_NODES.find(n => n.id === neighborId);
    if (!neighbor) return '';
    return \`<div class="neighbor-item" data-neighbor-id="\${escapeHtmlAttr(neighborId)}">
      <div class="neighbor-meta">
        <span class="neighbor-relation">\${edge.relation || 'calls'}</span>
        <span class="neighbor-confidence">\${edge.confidence || 'EXTRACTED'}</span>
      </div>
      <div class="neighbor-main">
        <div class="neighbor-main-left">
          <div class="neighbor-dot" style="background: \${neighbor.color.background};"></div>
          <span class="neighbor-name">\${neighbor.label || neighborId}</span>
        </div>
        <span class="neighbor-type">\${neighbor.node_type}</span>
      </div>
    </div>\`;
  }

  function toggleNeighbors(nodeId, direction, btn) {
    const isExpanded = btn.getAttribute('data-state') === 'expanded';
    const container = document.getElementById(direction + '-list-container');
    if (!container) return;

    const edges = RAW_EDGES.filter(e => {
      if (direction === 'outgoing') {
        if (e.from !== nodeId) return false;
        const neighbor = RAW_NODES.find(n => n.id === e.to);
        return neighbor && !hiddenNodeTypes.has(neighbor.node_type) && !hiddenCommunities.has(neighbor.community);
      } else {
        if (e.to !== nodeId) return false;
        const neighbor = RAW_NODES.find(n => n.id === e.from);
        return neighbor && !hiddenNodeTypes.has(neighbor.node_type) && !hiddenCommunities.has(neighbor.community);
      }
    });

    const sortEdges = (a, b) => {
      const neighborIdA = direction === 'outgoing' ? a.to : a.from;
      const neighborIdB = direction === 'outgoing' ? b.to : b.from;
      const nodeA = RAW_NODES.find(n => n.id === neighborIdA);
      const nodeB = RAW_NODES.find(n => n.id === neighborIdB);
      if (!nodeA || !nodeB) return 0;
      if (nodeA.node_type === 'intent' && nodeB.node_type !== 'intent') return -1;
      if (nodeB.node_type === 'intent' && nodeA.node_type !== 'intent') return 1;
      return (nodeB.degree || 0) - (nodeA.degree || 0);
    };
    edges.sort(sortEdges);

    if (isExpanded) {
      const visible = edges.slice(0, 5);
      container.innerHTML = visible.map(e => renderNeighborItem(e, direction)).join('');
      btn.innerText = 'Show all';
      btn.setAttribute('data-state', 'collapsed');
    } else {
      container.innerHTML = edges.map(e => renderNeighborItem(e, direction)).join('');
      btn.innerText = 'Show less';
      btn.setAttribute('data-state', 'expanded');
    }
  }

  const container = document.getElementById('container');
  const nodes = new vis.DataSet(RAW_NODES);
  const edges = new vis.DataSet(RAW_EDGES);
  const data = { nodes, edges };

  const options = {
    nodes: { shape: 'dot' },
    edges: {
      arrows: { to: { enabled: true, scaleFactor: 0.5 } },
      color: { inherit: 'from' },
      smooth: { type: 'continuous', roundness: 0.2 }
    },
    physics: {
      enabled: true,
      solver: 'forceAtlas2Based',
      forceAtlas2Based: {
        gravitationalConstant: -60,
        centralGravity: 0.005,
        springLength: 120,
        springConstant: 0.08,
        damping: 0.4,
        avoidOverlap: 0.8
      },
      stabilization: {
        enabled: true,
        iterations: 200,
        updateInterval: 25,
        fit: true
      }
    },
    interaction: { 
      hover: true, 
      tooltipDelay: 100,
      hideEdgesOnDrag: true,
      hideEdgesOnZoom: true,
      multiselect: true,
      navigationButtons: false,
      keyboard: true
    }
  };
  
  const network = new vis.Network(container, data, options);

  network.on("stabilizationIterationsDone", function() {
    document.getElementById('loading-overlay').style.opacity = '0';
    setTimeout(() => {
      document.getElementById('loading-overlay').style.display = 'none';
    }, 500);
    network.setOptions({ physics: { enabled: false } });
  });

  network.on("hoverNode", () => container.style.cursor = 'pointer');
  network.on("blurNode", () => container.style.cursor = 'default');
  network.on("hoverEdge", () => container.style.cursor = 'default');
  network.on("blurEdge", () => container.style.cursor = 'default');

  function showNodeInfo(nodeId) {
    const infoContent = document.getElementById('info-content');
    if (!nodeId) {
      infoContent.innerHTML = '<span class="empty">Select a node to view its properties</span>';
      return;
    }
    const nodeData = RAW_NODES.find(n => n.id === nodeId);
    if (!nodeData) return;

    let html = \`<div class="field"><b>ID</b> \${nodeData.id}</div>\`;
    html += \`<div class="field"><b>Type</b> \${nodeData.node_type}</div>\`;
    html += \`<div class="field"><b>Name</b> \${nodeData.label}</div>\`;
    html += \`<div class="field"><b>Links</b> \${nodeData.degree}</div>\`;

    if (nodeData.community !== undefined && nodeData.community !== 'none') {
      html += \`<div class="field"><b>Community</b> Community \${nodeData.community}</div>\`;
    }

    if (nodeData.source_file && !nodeData.source_file.startsWith('unresolved_') && nodeData.source_file !== 'import') {
      html += \`<div class="field"><b>Source</b> \${nodeData.source_file}</div>\`;
    }

    if (nodeData.startLine) {
      const lineText = nodeData.startLine === nodeData.endLine ? nodeData.startLine : \`\${nodeData.startLine} - \${nodeData.endLine}\`;
      html += \`<div class="field"><b>Lines</b> \${lineText}</div>\`;
    }

    if (nodeData.message) {
      html += \`<div class="field"><b>Message</b> \${nodeData.message.replace(/\\n/g, '<br>')}</div>\`;
    }

    if (nodeData.unresolved) {
      html += \`<div class="field"><b>Status</b> <span style="color:#EDC948">Unresolved</span></div>\`;
      if (nodeData.doc) html += \`<div class="field"><b>Reason</b> \${nodeData.doc}</div>\`;
    }

    const incomingEdges = RAW_EDGES.filter(e => {
      if (e.to !== nodeId) return false;
      const neighbor = RAW_NODES.find(n => n.id === e.from);
      return neighbor && !hiddenNodeTypes.has(neighbor.node_type) && !hiddenCommunities.has(neighbor.community);
    });
    const outgoingEdges = RAW_EDGES.filter(e => {
      if (e.from !== nodeId) return false;
      const neighbor = RAW_NODES.find(n => n.id === e.to);
      return neighbor && !hiddenNodeTypes.has(neighbor.node_type) && !hiddenCommunities.has(neighbor.community);
    });

    const sortEdges = (a, b, direction) => {
      const neighborIdA = direction === 'outgoing' ? a.to : a.from;
      const neighborIdB = direction === 'outgoing' ? b.to : b.from;
      const nodeA = RAW_NODES.find(n => n.id === neighborIdA);
      const nodeB = RAW_NODES.find(n => n.id === neighborIdB);
      if (!nodeA || !nodeB) return 0;
      if (nodeA.node_type === 'intent' && nodeB.node_type !== 'intent') return -1;
      if (nodeB.node_type === 'intent' && nodeA.node_type !== 'intent') return 1;
      return (nodeB.degree || 0) - (nodeA.degree || 0);
    };

    incomingEdges.sort((a, b) => sortEdges(a, b, 'incoming'));
    outgoingEdges.sort((a, b) => sortEdges(a, b, 'outgoing'));

    if (incomingEdges.length > 0) {
      html += \`<div class="neighbors-section">
        <div class="neighbors-header">Incoming Connections (\${incomingEdges.length})</div>
        <div id="incoming-list-container" class="neighbor-list">\`;
      
      const visibleIncoming = incomingEdges.slice(0, 5);
      html += visibleIncoming.map(e => renderNeighborItem(e, 'incoming')).join('');
      html += \`</div>\`;
      
      if (incomingEdges.length > 5) {
        html += \`<button class="show-more-btn" data-action="toggle-neighbors" data-node-id="\${escapeHtmlAttr(nodeId)}" data-direction="incoming" data-state="collapsed">Show all</button>\`;
      }
      html += \`</div>\`;
    }

    if (outgoingEdges.length > 0) {
      html += \`<div class="neighbors-section">
        <div class="neighbors-header">Outgoing Connections (\${outgoingEdges.length})</div>
        <div id="outgoing-list-container" class="neighbor-list">\`;
      
      const visibleOutgoing = outgoingEdges.slice(0, 5);
      html += visibleOutgoing.map(e => renderNeighborItem(e, 'outgoing')).join('');
      html += \`</div>\`;
      
      if (outgoingEdges.length > 5) {
        html += \`<button class="show-more-btn" data-action="toggle-neighbors" data-node-id="\${escapeHtmlAttr(nodeId)}" data-direction="outgoing" data-state="collapsed">Show all</button>\`;
      }
      html += \`</div>\`;
    }

    infoContent.innerHTML = html;
  }

  network.on("selectNode", (params) => showNodeInfo(params.nodes[0]));
  network.on("deselectNode", () => showNodeInfo(null));

  network.on("animationFinished", () => {
    network.setOptions({ edges: { hidden: false } });
  });

  const suggestionsBox = document.getElementById('search-suggestions');
  const searchInput = document.getElementById('search');

  searchInput.addEventListener('focus', () => {
    network.setOptions({ interaction: { keyboard: false } });
  });
  searchInput.addEventListener('blur', () => {
    network.setOptions({ interaction: { keyboard: true } });
  });

  let searchTimer;
  let activeSuggestionIndex = -1;
  let currentSuggestions = [];

  function hideSuggestions() {
    suggestionsBox.classList.add('hidden');
    suggestionsBox.innerHTML = '';
    activeSuggestionIndex = -1;
    currentSuggestions = [];
  }

  function showSuggestions(matched) {
    currentSuggestions = matched.slice(0, 10);
    if (currentSuggestions.length === 0) {
      hideSuggestions();
      return;
    }

    suggestionsBox.innerHTML = currentSuggestions.map((n, idx) => {
      const activeClass = idx === 0 ? 'active' : '';
      return \`<div class="suggestion-item \${activeClass}" data-id="\${escapeHtmlAttr(n.id)}" data-idx="\${idx}">
        <span class="suggestion-name">\${n.name || n.id}</span>
        <span class="suggestion-type">\${n.node_type}</span>
      </div>\`;
    }).join('');
    
    suggestionsBox.classList.remove('hidden');
    activeSuggestionIndex = 0;
  }

  function updateActiveSuggestion(index) {
    const items = suggestionsBox.getElementsByClassName('suggestion-item');
    for (let i = 0; i < items.length; i++) {
      if (i === index) {
        items[i].classList.add('active');
        items[i].scrollIntoView({ block: 'nearest' });
      } else {
        items[i].classList.remove('active');
      }
    }
    activeSuggestionIndex = index;
  }

  function selectSuggestion(nodeId) {
    const nodeData = RAW_NODES.find(n => n.id === nodeId);
    if (!nodeData) return;

    network.selectNodes([nodeId]);
    network.setOptions({ edges: { hidden: true } });
    network.focus(nodeId, { scale: 0.5, animation: { duration: 1000, easingFunction: 'easeInOutQuad' }});
    showNodeInfo(nodeId);
    searchInput.value = nodeData.label || nodeId;
    hideSuggestions();
  }

  searchInput.addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    const val = e.target.value.trim().toLowerCase();
    if (!val) {
      network.selectNodes([]);
      showNodeInfo(null);
      hideSuggestions();
      return;
    }
    searchTimer = setTimeout(() => {
      const terms = val.split(/\\s+/).filter(t => t.length > 0);
      if (terms.length === 0) return;

      const scored = [];
      for (const n of RAW_NODES) {
        if (hiddenNodeTypes.has(n.node_type)) continue;
        const name = (n.label || "").toLowerCase();
        const id = n.id.toLowerCase();
        const file = (n.source_file || "").toLowerCase();
        let score = 0;

        for (const t of terms) {
          if (t === name || t === id) {
            score += 1000;
          } else if (name.startsWith(t) || id.startsWith(t)) {
            score += 100;
          } else if (name.includes(t) || id.includes(t)) {
            score += 1;
          } else if (file.includes(t)) {
            score += 0.5;
          }
        }

        if (score > 0) {
          score += (n.degree || 0) * 0.01;
          scored.push({ id: n.id, name: n.label || n.id, node_type: n.node_type, score });
        }
      }

      scored.sort((a, b) => b.score - a.score);
      showSuggestions(scored);
    }, 400);
  });

  searchInput.addEventListener('keydown', (e) => {
    if (suggestionsBox.classList.contains('hidden')) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const nextIndex = (activeSuggestionIndex + 1) % currentSuggestions.length;
      updateActiveSuggestion(nextIndex);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const prevIndex = (activeSuggestionIndex - 1 + currentSuggestions.length) % currentSuggestions.length;
      updateActiveSuggestion(prevIndex);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (activeSuggestionIndex >= 0 && activeSuggestionIndex < currentSuggestions.length) {
        selectSuggestion(currentSuggestions[activeSuggestionIndex].id);
        searchInput.blur();
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      hideSuggestions();
    }
  });

  suggestionsBox.addEventListener('click', (e) => {
    const item = e.target.closest('.suggestion-item');
    if (item) {
      const id = item.getAttribute('data-id');
      selectSuggestion(id);
    }
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('#search-box')) {
      hideSuggestions();
    }
  });

  document.getElementById('info-content').addEventListener('click', (e) => {
    const neighborItem = e.target.closest('.neighbor-item');
    if (neighborItem) {
      const neighborId = neighborItem.getAttribute('data-neighbor-id');
      if (neighborId) {
        selectSuggestion(neighborId);
        return;
      }
    }

    const showMoreBtn = e.target.closest('.show-more-btn');
    if (showMoreBtn && showMoreBtn.getAttribute('data-action') === 'toggle-neighbors') {
      const nodeId = showMoreBtn.getAttribute('data-node-id');
      const direction = showMoreBtn.getAttribute('data-direction');
      if (nodeId && direction) {
        toggleNeighbors(nodeId, direction, showMoreBtn);
      }
    }
  });

  function updateNodeVisibilities() {
    const updates = [];
    let selectedHidden = false;
    const selectedIds = network.getSelectedNodes();
    
    for (const n of RAW_NODES) {
      const shouldHide = hiddenNodeTypes.has(n.node_type) || hiddenCommunities.has(n.community);
      updates.push({
        id: n.id,
        hidden: shouldHide
      });
      if (shouldHide && selectedIds.includes(n.id)) {
        selectedHidden = true;
      }
    }
    nodes.update(updates);
    
    if (selectedHidden) {
      network.selectNodes([]);
      showNodeInfo(null);
    }
  }

  document.getElementById('legend').addEventListener('click', (e) => {
    const item = e.target.closest('.legend-item');
    if (!item) return;

    if (currentViewMode === 'types') {
      const typesStr = item.getAttribute('data-type');
      if (typesStr) {
        const types = typesStr.split(',');
        const isCurrentlyHidden = hiddenNodeTypes.has(types[0]);
        for (const t of types) {
          if (isCurrentlyHidden) {
            hiddenNodeTypes.delete(t);
          } else {
            hiddenNodeTypes.add(t);
          }
        }
        
        if (isCurrentlyHidden) {
          item.classList.remove('inactive');
        } else {
          item.classList.add('inactive');
        }
        
        updateNodeVisibilities();
      }
    } else {
      const commId = item.getAttribute('data-community');
      if (commId) {
        const isCurrentlyHidden = hiddenCommunities.has(commId);
        if (isCurrentlyHidden) {
          hiddenCommunities.delete(commId);
          item.classList.remove('inactive');
        } else {
          hiddenCommunities.add(commId);
          item.classList.add('inactive');
        }
        
        updateNodeVisibilities();
      }
    }
  });
</script>
</body>
</html>`;

  const htmlPath = path.join(outDir, "graph.html");
  fs.writeFileSync(htmlPath, htmlContent, "utf-8");

  return htmlPath;
}
