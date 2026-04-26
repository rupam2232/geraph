import fs from "fs";
import path from "path";
import type { MultiDirectedGraph } from "graphology";
import type { NodeData, EdgeData } from "./graph.js";

/**
 * Compresses and serializes the Graphology instance into a clean JSON structure
 * suitable for LLM injection ("Caveman Mode").
 */
export function exportGraphJson(
  graph: MultiDirectedGraph<NodeData, EdgeData>,
  outDir: string,
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

  const payload = {
    version: "1.0.0",
    nodes,
    edges,
  };

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
) {
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  let md = `# Graphine Codebase Report\n\n`;

  // Section 1: Architecture (Files and Functions)
  md += `## Architecture Structure\n`;
  const fileNodes = graph
    .nodes()
    .filter((n) => graph.getNodeAttribute(n, "type") === "file");

  for (const file of fileNodes) {
    const data = graph.getNodeAttributes(file);
    if (data.metadata?.external) continue;

    md += `- **${data.name}**\n`;

    // Find classes and functions defined in this file
    const definesEdges = graph.outEdges(file).filter((edgeId) => {
      return graph.getEdgeAttribute(edgeId, "type") === "defines";
    });

    for (const edgeId of definesEdges) {
      const target = graph.target(edgeId);
      const targetData = graph.getNodeAttributes(target);
      md += `  - \`${targetData.type} ${targetData.name}\`\n`;
    }
  }

  // Section 2: Temporal Facts (Intent)
  const intentNodes = graph
    .nodes()
    .filter((n) => graph.getNodeAttribute(n, "type") === "intent");

  if (intentNodes.length > 0) {
    md += `\n## Recent Architectural Changes & Intent\n`;
    for (const intent of intentNodes) {
      const data = graph.getNodeAttributes(intent);
      const msg = data.metadata?.message || "";
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
) {
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  const counts: Record<string, number> = {
    file: 0,
    class: 0,
    function: 0,
    intent: 0,
  };

  const RAW_NODES = graph.nodes().map((n) => {
    const data = graph.getNodeAttributes(n);
    let color = "#64748b"; // default
    if (data.type === "file") color = "#3b82f6";
    else if (data.type === "class") color = "#10b981";
    else if (data.type === "function") color = "#f59e0b";
    else if (data.type === "intent") color = "#a855f7";

    if (data.type && counts[data.type] !== undefined) {
      counts[data.type] = (counts[data.type] || 0) + 1;
    }

    let sourceFile = "";
    if (n.includes("::")) {
      sourceFile = n.split("::")[0] as string;
    } else if (data.type === "file") {
      sourceFile = n;
    }

    return {
      id: n,
      label: data.name,
      title: data.name,
      color: {
        background: color,
        border: color,
        highlight: { background: "#ffffff", border: color },
      },
      size: data.type === "file" ? 20 : data.type === "intent" ? 25 : 15,
      font: { size: 12, color: "#ffffff" },
      node_type: data.type,
      source_file: sourceFile,
      ...data.metadata,
    };
  });

  const RAW_EDGES = graph.edges().map((e) => {
    const source = graph.source(e);
    const target = graph.target(e);
    const data = graph.getEdgeAttributes(e);
    return {
      from: source,
      to: target,
      label: data.type,
      color: { color: "rgba(255,255,255,0.2)", highlight: "#ffffff" },
      arrows: "to",
      font: { size: 10, color: "#aaa", align: "middle" },
    };
  });

  const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Graphine - Knowledge Graph</title>
<script src="https://unpkg.com/vis-network/standalone/umd/vis-network.min.js"></script>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #0f0f1a; color: #e0e0e0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; display: flex; height: 100vh; overflow: hidden; }
  #graph { flex: 1; }
  #sidebar { width: 320px; background: #1a1a2e; border-left: 1px solid #2a2a4e; display: flex; flex-direction: column; overflow: hidden; }
  #search-wrap { padding: 12px; border-bottom: 1px solid #2a2a4e; }
  #search { width: 100%; background: #0f0f1a; border: 1px solid #3a3a5e; color: #e0e0e0; padding: 8px 12px; border-radius: 6px; font-size: 13px; outline: none; }
  #search:focus { border-color: #4E79A7; }
  #info-panel { padding: 14px; border-bottom: 1px solid #2a2a4e; min-height: 200px; flex: 1; overflow-y: auto; }
  #info-panel h3 { font-size: 13px; color: #aaa; margin-bottom: 12px; text-transform: uppercase; letter-spacing: 0.05em; }
  #info-content { font-size: 13px; color: #ccc; line-height: 1.6; word-break: break-word; }
  #info-content .field { margin-bottom: 8px; }
  #info-content .field b { color: #e0e0e0; display: block; font-size: 11px; text-transform: uppercase; margin-bottom: 2px; }
  #info-content .empty { color: #555; font-style: italic; }
  #legend-wrap { padding: 12px; border-top: 1px solid #2a2a4e; }
  #legend-wrap h3 { font-size: 13px; color: #aaa; margin-bottom: 10px; text-transform: uppercase; letter-spacing: 0.05em; }
  .legend-item { display: flex; align-items: center; gap: 8px; padding: 4px 0; font-size: 12px; justify-content: space-between; }
  .legend-item-left { display: flex; align-items: center; gap: 8px; }
  .legend-dot { width: 12px; height: 12px; border-radius: 50%; flex-shrink: 0; }
  .legend-count { color: #666; font-size: 11px; }
  #stats { padding: 10px 14px; border-top: 1px solid #2a2a4e; font-size: 11px; color: #555; background: #151525; }
</style>
</head>
<body>
<div id="graph"></div>
<div id="sidebar">
  <div id="search-wrap">
    <input id="search" type="text" placeholder="Search nodes..." autocomplete="off">
  </div>
  <div id="info-panel">
    <h3>Node Info</h3>
    <div id="info-content"><span class="empty">Click a node to inspect it</span></div>
  </div>
  <div id="legend-wrap">
    <h3>Legend</h3>
    <div class="legend-item"><div class="legend-item-left"><div class="legend-dot" style="background: #3b82f6;"></div> File</div><span class="legend-count">${counts.file || 0}</span></div>
    <div class="legend-item"><div class="legend-item-left"><div class="legend-dot" style="background: #10b981;"></div> Class</div><span class="legend-count">${counts.class || 0}</span></div>
    <div class="legend-item"><div class="legend-item-left"><div class="legend-dot" style="background: #f59e0b;"></div> Function</div><span class="legend-count">${counts.function || 0}</span></div>
    <div class="legend-item"><div class="legend-item-left"><div class="legend-dot" style="background: #a855f7;"></div> Git Commit (Intent)</div><span class="legend-count">${counts.intent || 0}</span></div>
  </div>
  <div id="stats">${RAW_NODES.length} nodes &middot; ${RAW_EDGES.length} edges</div>
</div>
<script>
  const RAW_NODES = ${JSON.stringify(RAW_NODES)};
  const RAW_EDGES = ${JSON.stringify(RAW_EDGES)};

  const nodes = new vis.DataSet(RAW_NODES);
  const edges = new vis.DataSet(RAW_EDGES);
  const container = document.getElementById('graph');
  
  const data = { nodes: nodes, edges: edges };
  const options = {
    nodes: { shape: 'dot', borderWidth: 2 },
    edges: { smooth: { type: 'continuous' } },
    physics: {
      barnesHut: { gravitationalConstant: -20000, centralGravity: 0.3, springLength: 95, springConstant: 0.04, damping: 0.09 },
      stabilization: { iterations: 150 }
    },
    interaction: { hover: true, tooltipDelay: 200 }
  };
  
  const network = new vis.Network(container, data, options);

  // ── Shared helper: populate the info panel for a given node ID ────────────
  function showNodeInfo(nodeId) {
    const infoContent = document.getElementById('info-content');
    const nodeData = RAW_NODES.find(n => n.id === nodeId);
    if (!nodeData) {
      infoContent.innerHTML = '<span class="empty">Node not found</span>';
      return;
    }

    let html = \`<div class="field"><b>ID</b> \${nodeData.id}</div>\`;
    html += \`<div class="field"><b>Type</b> \${nodeData.node_type}</div>\`;
    html += \`<div class="field"><b>Name</b> \${nodeData.label}</div>\`;

    // Source file (for defined nodes; skip ghost import/unresolved nodes)
    if (nodeData.source_file && nodeData.source_file !== 'unresolved_fn' && nodeData.source_file !== 'import') {
      html += \`<div class="field"><b>Source</b> \${nodeData.source_file}</div>\`;
    }

    // For external import ghost nodes, show which file imported them and from which line
    if (nodeData.id && nodeData.id.startsWith && nodeData.id.startsWith('import::') && nodeData.callerFile) {
      html += \`<div class="field"><b>Imported in</b> \${nodeData.callerFile}\${nodeData.callerLine ? ':' + nodeData.callerLine : ''}</div>\`;
    }

    // Lines: show "16" instead of "16 - 16" when single-line
    if (nodeData.startLine) {
      const lineText = nodeData.startLine === nodeData.endLine
        ? \`\${nodeData.startLine}\`
        : \`\${nodeData.startLine} \u2013 \${nodeData.endLine}\`;
      html += \`<div class="field"><b>Lines</b> \${lineText}</div>\`;
    }

    // Git commit message — render newlines as <br> for readability
    if (nodeData.message) {
      html += \`<div class="field"><b>Message</b> \${nodeData.message.replace(/\\n/g, '<br>')}</div>\`;
    }

    // Unresolved function: show why and where it was called from
    if (nodeData.unresolved) {
      html += \`<div class="field"><b>Status</b> <span style="color:#f59e0b">Unresolved</span></div>\`;
      if (nodeData.reason) {
        html += \`<div class="field"><b>Reason</b> \${nodeData.reason}</div>\`;
      }
      if (nodeData.callerFile) {
        html += \`<div class="field"><b>First called from</b> \${nodeData.callerFile}\${nodeData.callerLine ? ':' + nodeData.callerLine : ''}</div>\`;
      }
    }

    infoContent.innerHTML = html;
  }

  // ── Search: select all matches, focus + show info for first result ─────────
  document.getElementById('search').addEventListener('input', function(e) {
    const val = e.target.value.toLowerCase();
    if (!val) {
      network.selectNodes([]);
      document.getElementById('info-content').innerHTML = '<span class="empty">Click a node to inspect it</span>';
      return;
    }
    const matched = RAW_NODES.filter(n => n.label.toLowerCase().includes(val)).map(n => n.id);
    if (matched.length > 0) {
      network.selectNodes(matched);
      network.focus(matched[0], { scale: 1, animation: { duration: 1000, easingFunction: 'easeInOutQuad' }});
      showNodeInfo(matched[0]);
    }
  });

  // ── Click: focus + show info for clicked node ──────────────────────────────
  network.on("click", function (params) {
    if (params.nodes.length > 0) {
      const nodeId = params.nodes[0];
      network.focus(nodeId, { scale: 1, animation: { duration: 1000, easingFunction: 'easeInOutQuad' } });
      showNodeInfo(nodeId);
    } else {
      document.getElementById('info-content').innerHTML = '<span class="empty">Click a node to inspect it</span>';
    }
  });
</script>
</body>
</html>`;

  const htmlPath = path.join(outDir, "graph.html");
  fs.writeFileSync(htmlPath, htmlContent, "utf-8");

  return htmlPath;
}
