// We use the underlying Server class instead of the newer McpServer to avoid a heavy 'zod' dependency.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { MultiDirectedGraph } from "graphology";
import type { NodeData, EdgeData } from "./graph.js";
import fs from "fs";
import path from "path";

/**
 * Initializes and runs the MCP server via stdio.
 */
export async function runMcpServer(
  graph: MultiDirectedGraph<NodeData, EdgeData>,
  targetDir: string,
) {
  const server = new Server(
    {
      name: "geraph",
      version: "1.1.0",
    },
    {
      capabilities: {
        tools: {},
        resources: {},
      },
    },
  );

  // 1. Define the Tools
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: "search_graph",
          description:
            "Search for nodes in the knowledge graph by partial name. Useful to find exact node IDs. Supports pagination. You can also search for a file by its path (e.g., 'src/auth.ts') using type 'file', because node IDs contain file paths. (CLI Alternative: 'geraph search <term>')",
          inputSchema: {
            type: "object",
            properties: {
              name: {
                type: "string",
                description: "The partial name to search for (e.g. 'auth')",
              },
              type: {
                type: "string",
                description:
                  "Optional filter by node type (e.g. 'function', 'class')",
              },
              page: {
                type: "number",
                description: "Page number for pagination (default: 1)",
              },
              limit: {
                type: "number",
                description: "Number of results per page (default: 20)",
              },
            },
            required: ["name"],
          },
        },
        {
          name: "get_node",
          description:
            "Get detailed metadata for a specific node by its exact ID or fuzzy symbol name. (CLI Alternative: 'geraph node <symbol>')",
          inputSchema: {
            type: "object",
            properties: {
              symbol: {
                type: "string",
                description: "The exact node ID or symbol name",
              },
              type: {
                type: "string",
                description:
                  "Optional filter by node type (e.g., 'interface', 'function')",
              },
              source: {
                type: "string",
                description:
                  "Optional filter by source file path (e.g., 'auth.ts')",
              },
            },
            required: ["symbol"],
          },
        },
        {
          name: "get_neighbors",
          description:
            "Get all incoming and outgoing edges for a specific node to trace its direct dependencies. Supports pagination. (CLI Alternative: 'geraph neighbors <symbol>')",
          inputSchema: {
            type: "object",
            properties: {
              symbol: {
                type: "string",
                description: "The exact node ID or symbol name",
              },
              type: {
                type: "string",
                description:
                  "Optional filter by node type (e.g., 'interface', 'function')",
              },
              source: {
                type: "string",
                description:
                  "Optional filter by source file path (e.g., 'auth.ts')",
              },
              page: {
                type: "number",
                description: "Page number for pagination (default: 1)",
              },
              limit: {
                type: "number",
                description:
                  "Number of edges per direction per page (default: 20)",
              },
            },
            required: ["symbol"],
          },
        },
        {
          name: "shortest_path",
          description:
            "Find the shortest sequence of edges connecting two nodes using fuzzy symbol/ID lookup. (CLI Alternative: 'geraph path <source> <target>')",
          inputSchema: {
            type: "object",
            properties: {
              source: {
                type: "string",
                description: "The fuzzy starting node ID or symbol name",
              },
              target: {
                type: "string",
                description: "The fuzzy destination node ID or symbol name",
              },
              max_hops: {
                type: "number",
                description: "Maximum hops to consider (default: 8)",
              },
            },
            required: ["source", "target"],
          },
        },
        {
          name: "god_nodes",
          description:
            "Return the most connected nodes — the core architectural pillars of the codebase. Supports pagination. (CLI Alternative: 'geraph god')",
          inputSchema: {
            type: "object",
            properties: {
              page: {
                type: "number",
                description: "Page number for pagination (default: 1)",
              },
              limit: {
                type: "number",
                description: "Number of results per page (default: 10)",
              },
            },
          },
        },
        {
          name: "get_community",
          description:
            "Get all nodes in a community by community ID. Supports pagination. (CLI Alternative: 'geraph community <id>')",
          inputSchema: {
            type: "object",
            properties: {
              community_id: {
                type: "number",
                description: "Community ID (0-indexed by size)",
              },
              page: {
                type: "number",
                description: "Page number for pagination (default: 1)",
              },
              limit: {
                type: "number",
                description: "Number of results per page (default: 20)",
              },
            },
            required: ["community_id"],
          },
        },
        {
          name: "get_surprises",
          description:
            "Discover surprising cross-community couplings that link otherwise independent modules. Supports pagination. (CLI Alternative: 'geraph surprises')",
          inputSchema: {
            type: "object",
            properties: {
              page: {
                type: "number",
                description: "Page number for pagination (default: 1)",
              },
              limit: {
                type: "number",
                description: "Number of results per page (default: 20)",
              },
            },
          },
        },
        {
          name: "query_graph",
          description:
            "Search the AST graph using BFS or DFS traversal. Returns a compact context representation. Supports natural language questions or keywords. (CLI Alternative: 'geraph query <symbol-or-question>')",
          inputSchema: {
            type: "object",
            properties: {
              symbol: {
                type: "string",
                description: "Fuzzy starting symbol or node ID, or natural language question",
              },
              question: {
                type: "string",
                description: "Natural language question or keywords (for Graphify parity)",
              },
              mode: {
                type: "string",
                enum: ["bfs", "dfs"],
                default: "bfs",
                description: "Traversal mode: bfs (breadth) or dfs (depth)",
              },
              depth: {
                type: "number",
                default: 3,
                description: "Traversal depth limit",
              },
              token_budget: {
                type: "number",
                default: 2000,
                description: "Estimated output token limit",
              },
            },
          },
        },
        {
          name: "graph_stats",
          description:
            "Return summary statistics of the graph: node count, edge count, community count, and extraction confidence percentage breakdown. (CLI Alternative: 'geraph stats')",
          inputSchema: {
            type: "object",
            properties: {},
          },
        },
        {
          name: "scan_graph",
          description:
            "Triggers a full rebuild of the Geraph AST graph. Use this after making significant code modifications or pushing git commits to ensure your structural memory is up-to-date. (CLI Alternative: 'geraph scan')",
          inputSchema: {
            type: "object",
            properties: {
              force: {
                type: "boolean",
                description: "If true, fully ignore and rebuild all cache files (doing a clean scan from scratch)",
              },
            },
          },
        },
      ],
    };
  });

  // 2. Handle Tool Invocations
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    if (!args) {
      throw new Error("Arguments are required");
    }

    try {
      if (name === "search_graph") {
        const queryName = args.name as string;
        const typeFilter = args.type as string | undefined;
        const page = args.page as number | undefined;
        const limit = args.limit as number | undefined;

        const { searchGraph } = await import("./query.js");
        const matches = await searchGraph(
          graph,
          queryName,
          typeFilter,
          page,
          limit,
        );

        return {
          content: [{ type: "text", text: JSON.stringify(matches, null, 2) }],
        };
      }

      if (name === "get_node") {
        const symbol = args.symbol as string;
        const typeFilter = args.type as string | undefined;
        const sourceFilter = args.source as string | undefined;

        const { getNode } = await import("./query.js");
        try {
          const result = await getNode(graph, symbol, typeFilter, sourceFilter);
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  error: error instanceof Error ? error.message : String(error),
                }),
              },
            ],
            isError: true,
          };
        }
      }

      if (name === "get_neighbors") {
        const symbol = args.symbol as string;
        const typeFilter = args.type as string | undefined;
        const sourceFilter = args.source as string | undefined;
        const page = args.page as number | undefined;
        const limit = args.limit as number | undefined;

        const { getNeighbors } = await import("./query.js");
        try {
          const result = await getNeighbors(
            graph,
            symbol,
            typeFilter,
            sourceFilter,
            page,
            limit,
          );
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  error: error instanceof Error ? error.message : String(error),
                }),
              },
            ],
            isError: true,
          };
        }
      }

      if (name === "shortest_path") {
        const source = args.source as string;
        const target = args.target as string;
        const maxHops = args.max_hops !== undefined ? Number(args.max_hops) : 8;

        const { shortestPath } = await import("./query.js");
        try {
          const result = await shortestPath(graph, source, target, maxHops);
          return {
            content: [
              {
                type: "text",
                text: result,
              },
            ],
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  error: error instanceof Error ? error.message : String(error),
                }),
              },
            ],
            isError: true,
          };
        }
      }

      if (name === "god_nodes") {
        const page = (args.page as number) || 1;
        const limit = (args.limit as number) || 10;
        const { getGodNodes } = await import("./query.js");
        try {
          const result = await getGodNodes(graph, page, limit);
          return {
            content: [{ type: "text", text: result }],
          };
        } catch (error) {
          return {
            content: [{ type: "text", text: String(error) }],
            isError: true,
          };
        }
      }

      if (name === "get_community") {
        const communityId = Number(args.community_id);
        const page = (args.page as number) || 1;
        const limit = (args.limit as number) || 20;
        const { getCommunityNodes } = await import("./query.js");
        try {
          const result = await getCommunityNodes(
            graph,
            communityId,
            page,
            limit,
          );
          return {
            content: [{ type: "text", text: result }],
          };
        } catch (error) {
          return {
            content: [{ type: "text", text: String(error) }],
            isError: true,
          };
        }
      }

      if (name === "get_surprises") {
        const page = (args.page as number) || 1;
        const limit = (args.limit as number) || 20;
        const { getSurprisingConnections } = await import("./query.js");
        try {
          const result = await getSurprisingConnections(graph, page, limit);
          return {
            content: [{ type: "text", text: result }],
          };
        } catch (error) {
          return {
            content: [{ type: "text", text: String(error) }],
            isError: true,
          };
        }
      }

      if (name === "query_graph") {
        const symbol = (args.symbol || args.question) as string;
        if (!symbol) {
          throw new Error("Either 'symbol' or 'question' parameter is required");
        }
        const mode = (args.mode as "bfs" | "dfs") || "bfs";
        const depth = Number(args.depth ?? 3);
        const tokenBudget = Number(args.token_budget ?? 2000);
        const { queryGraph } = await import("./query.js");
        try {
          const result = await queryGraph(
            graph,
            symbol,
            mode,
            depth,
            tokenBudget,
          );
          return {
            content: [{ type: "text", text: result }],
          };
        } catch (error) {
          return {
            content: [{ type: "text", text: String(error) }],
            isError: true,
          };
        }
      }

      if (name === "graph_stats") {
        const { getGraphStats } = await import("./query.js");
        try {
          const result = await getGraphStats(graph);
          return {
            content: [{ type: "text", text: result }],
          };
        } catch (error) {
          return {
            content: [{ type: "text", text: String(error) }],
            isError: true,
          };
        }
      }

      if (name === "scan_graph") {
        try {
          const { exec } = await import("child_process");
          const { promisify } = await import("util");
          const execAsync = promisify(exec);

          const force = !!(args as Record<string, unknown>).force;
          const cmd = force ? "geraph scan --force" : "geraph scan";
          const { stdout, stderr } = await execAsync(cmd, { cwd: targetDir });

          const { loadGraph } = await import("./query.js");
          const newGraph = loadGraph(targetDir);

          graph.clear();
          newGraph.forEachNode((node, attr) => graph.addNode(node, attr));
          newGraph.forEachEdge((edge, attr, source, target) =>
            graph.addEdgeWithKey(edge, source, target, attr),
          );

          // Strip ANSI escape codes
          const stripAnsi = (str: string) =>
            str.replace(
              // eslint-disable-next-line no-control-regex
              /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g,
              "",
            );
          const cleanStdout = stripAnsi(stdout);
          const cleanStderr = stripAnsi(stderr);

          // Extract files count line and real warnings from stderr
          const lines = cleanStderr
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean);
          let filesParsedLine = "";
          const realWarnings: string[] = [];

          // Keywords indicating temporary CLI loader/spinner status lines
          const SPINNER_KEYWORDS = [
            "Scanning codebase in",
            "Initializing Knowledge Graph",
            "Resolving call graph",
            "Extracting Temporal Facts",
            "Analyzing graph structure",
            "Compressing graph into Caveman",
          ];

          for (const line of lines) {
            if (line.includes("Successfully scanned and parsed")) {
              // Strip leading checkmarks/spinners if any
              filesParsedLine = line.replace(/^[^\w]+/, "").trim();
            } else if (SPINNER_KEYWORDS.some((kw) => line.includes(kw))) {
              // Skip the temporary loading line
            } else {
              realWarnings.push(line);
            }
          }

          let outputText = "";
          if (filesParsedLine) {
            const displayLine = filesParsedLine.startsWith("Successfully")
              ? filesParsedLine
              : `Successfully ${filesParsedLine}`;
            outputText += `${displayLine}\n\n`;
          }

          outputText += cleanStdout.trim();

          if (realWarnings.length > 0) {
            outputText += `\n\nWarnings/Errors:\n${realWarnings.join("\n")}`;
          }

          return {
            content: [
              {
                type: "text",
                text: outputText.trim() || "Graph successfully scanned and memory updated.",
              },
            ],
          };
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          return {
            content: [{ type: "text", text: `Error scanning graph: ${msg}` }],
            isError: true,
          };
        }
      }

      throw new Error(`Unknown tool: ${name}`);
    } catch (error) {
      const err = error as Error;
      return {
        content: [
          { type: "text", text: JSON.stringify({ error: err.message }) },
        ],
        isError: true,
      };
    }
  });

  // 3. Define Resources
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    return {
      resources: [
        {
          uri: "geraph://report",
          name: "Graph Report",
          description: "Full GRAPH_REPORT.md",
          mimeType: "text/markdown",
        },
        {
          uri: "geraph://stats",
          name: "Graph Stats",
          description: "Node/edge/community counts and confidence breakdown",
          mimeType: "text/plain",
        },
        {
          uri: "geraph://god-nodes",
          name: "God Nodes",
          description: "Top 10 most-connected nodes",
          mimeType: "text/plain",
        },
        {
          uri: "geraph://surprises",
          name: "Surprising Connections",
          description: "Cross-community surprising connections",
          mimeType: "text/plain",
        },
        {
          uri: "geraph://audit",
          name: "Confidence Audit",
          description: "EXTRACTED/INFERRED/AMBIGUOUS edge breakdown",
          mimeType: "text/plain",
        },
      ],
    };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;

    if (uri === "geraph://report") {
      const reportPath = path.join(targetDir, ".geraph", "GRAPH_REPORT.md");
      if (fs.existsSync(reportPath)) {
        return {
          contents: [
            {
              uri,
              mimeType: "text/markdown",
              text: fs.readFileSync(reportPath, "utf-8"),
            },
          ],
        };
      }
      return {
        contents: [
          {
            uri,
            mimeType: "text/markdown",
            text: "GRAPH_REPORT.md not found. Run geraph scan first.",
          },
        ],
      };
    }

    if (uri === "geraph://stats") {
      const { getGraphStats } = await import("./query.js");
      const text = await getGraphStats(graph);
      return {
        contents: [{ uri, mimeType: "text/plain", text }],
      };
    }

    if (uri === "geraph://god-nodes") {
      const { getGodNodes } = await import("./query.js");
      const text = await getGodNodes(graph, 1, 10);
      return {
        contents: [{ uri, mimeType: "text/plain", text }],
      };
    }

    if (uri === "geraph://surprises") {
      const { getSurprisingConnections } = await import("./query.js");
      const text = await getSurprisingConnections(graph, 1, 10);
      return {
        contents: [{ uri, mimeType: "text/plain", text }],
      };
    }

    if (uri === "geraph://audit") {
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

      const text = [
        `Total edges: ${total}`,
        `EXTRACTED: ${extractedCount} (${extPct}%)`,
        `INFERRED: ${inferredCount} (${infPct}%)`,
        `AMBIGUOUS: ${ambiguousCount} (${ambPct}%)`,
      ].join("\n");

      return {
        contents: [{ uri, mimeType: "text/plain", text }],
      };
    }

    throw new Error(`Unknown resource: ${uri}`);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // We intentionally do NOT log to stdout because it would break JSON-RPC over stdio.
  console.error("Geraph MCP Server is running over stdio");
}
