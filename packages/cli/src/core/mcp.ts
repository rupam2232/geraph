// We use the underlying Server class instead of the newer McpServer to avoid a heavy 'zod' dependency.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { MultiDirectedGraph } from "graphology";
import type { NodeData, EdgeData } from "./graph.js";

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
      version: "0.3.0",
    },
    {
      capabilities: {
        tools: {},
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
              symbol: { type: "string", description: "The exact node ID or symbol name" },
              type: { type: "string", description: "Optional filter by node type (e.g., 'interface', 'function')" },
              source: { type: "string", description: "Optional filter by source file path (e.g., 'auth.ts')" },
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
              symbol: { type: "string", description: "The exact node ID or symbol name" },
              type: { type: "string", description: "Optional filter by node type (e.g., 'interface', 'function')" },
              source: { type: "string", description: "Optional filter by source file path (e.g., 'auth.ts')" },
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
            "Find the shortest sequence of edges connecting two nodes. Note: This tool strictly requires exact node IDs, not fuzzy symbol names. (CLI Alternative: 'geraph path <source> <target>')",
          inputSchema: {
            type: "object",
            properties: {
              source_id: {
                type: "string",
                description: "The exact starting node ID",
              },
              target_id: {
                type: "string",
                description: "The exact destination node ID",
              },
            },
            required: ["source_id", "target_id"],
          },
        },
        {
          name: "scan_graph",
          description:
            "Triggers a full rebuild of the Geraph AST graph. Use this after making significant code modifications or pushing git commits to ensure your structural memory is up-to-date. (CLI Alternative: 'geraph scan')",
          inputSchema: {
            type: "object",
            properties: {},
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
            content: [
              { type: "text", text: JSON.stringify(result, null, 2) },
            ],
          };
        } catch (error) {
          return {
            content: [{ type: "text", text: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) }],
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
            content: [{ type: "text", text: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) }],
            isError: true,
          };
        }
      }

      if (name === "shortest_path") {
        const sourceId = args.source_id as string;
        const targetId = args.target_id as string;

        if (!graph.hasNode(sourceId)) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  error: `Source node '${sourceId}' not found`,
                }),
              },
            ],
            isError: true,
          };
        }
        if (!graph.hasNode(targetId)) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  error: `Target node '${targetId}' not found`,
                }),
              },
            ],
            isError: true,
          };
        }

        const { shortestPath } = await import("./query.js");
        try {
          const result = await shortestPath(graph, sourceId, targetId);
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

      if (name === "scan_graph") {
        try {
          const { exec } = await import("child_process");
          const { promisify } = await import("util");
          const execAsync = promisify(exec);

          await execAsync("geraph scan", { cwd: targetDir });

          const { loadGraph } = await import("./query.js");
          const newGraph = loadGraph(targetDir);

          graph.clear();
          newGraph.forEachNode((node, attr) => graph.addNode(node, attr));
          newGraph.forEachEdge((edge, attr, source, target) =>
            graph.addEdgeWithKey(edge, source, target, attr),
          );

          let communitiesCount = 0;
          try {
            const { readFileSync } = await import("fs");
            const { join } = await import("path");
            const graphJsonPath = join(targetDir, ".geraph", "graph.json");
            const raw = readFileSync(graphJsonPath, "utf8");
            const data = JSON.parse(raw);
            communitiesCount = data.analysis?.communities?.length || 0;
          } catch {
            // Ignore
          }

          return {
            content: [
              {
                type: "text",
                text: `Graph successfully scanned and memory updated. Discovered ${graph.order} nodes, ${graph.size} edges, and ${communitiesCount} communities.`,
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

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // We intentionally do NOT log to stdout because it would break JSON-RPC over stdio.
  console.error("Geraph MCP Server is running over stdio");
}
