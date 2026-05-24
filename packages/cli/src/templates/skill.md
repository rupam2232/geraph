---
name: geraph
description: "Structural Memory for AI Agents. Navigate the codebase via AST graph."
trigger: /geraph
---

# Geraph Operational Manual

Geraph is a structural memory engine that tracks dependencies, function calls, imports, and historical context (Git commits) across the codebase. It builds a graph mapping all relationships without executing any code.

## What You Must Do When Invoked

When you need to understand the architecture, find where a component is, or trace dependencies, follow this strict protocol:

### Step 0: Check for Native MCP Tools (Recommended)
If your environment has configured the Geraph MCP Server, you will natively see these tools available: `search_graph`, `get_node`, `get_neighbors`, and `shortest_path`. **You MUST prioritize using these native tools** over running terminal CLI commands, as they are faster, strictly typed, and not subject to terminal output bugs. If they are available, use them and skip the CLI steps below.

### Step 1: Read the Global Architecture Report
Before answering architecture or codebase questions, **always read `.geraph/GRAPH_REPORT.md` first**. It contains project stats, core architectural pillars ("God Nodes"), and community clustering. 

### Step 2: Use `search` for Fuzzy Discovery
If you don't know the exact ID or exact name of a symbol, you MUST use `search` first.

**MCP Tool:** `search_graph`\
**CLI Command:**
```bash
geraph search '<term>' [--type <type>] [--page <number>] [--limit <number>]
```
- **Inputs**: Use a broad concept, a partial filename, or a partial function name. For example: `search 'auth'`, `search 'database'`, `search 'User'`.
- **Note on Files**: You can search for a file using its filepath because node IDs contain file paths. Use `type: "file"` to narrow it down (e.g., `search_graph` with `name: "src/auth.ts"`, `type: "file"`).
- **Options**: You can filter by `--type file` or `--type function` if you know what you are looking for. You can also use `--page` and `--limit` to paginate through large result sets. For MCP tools, pass `page` and `limit` arguments.
- **Output**: Returns a paginated wrapper with a `data` array of matches and a `meta` block (current page, total pages). 

### Step 3: Use `query` for Deep Inspection
Once you have found the exact Node ID or exact Symbol Name from Step 2 (or if the user explicitly provided one), use `query` to fetch its full dependencies.

**MCP Tools:** `get_node` (for node metadata) or `get_neighbors` (for tracing edges and dependencies).\
**CLI Command:**
```bash
geraph query '<symbol_or_id>' [--type <type>] [--source <file>] [--page <number>] [--limit <number>]
```
- **Inputs**: The exact Node ID (e.g., `src/auth/session.ts::ValidateToken`) or the exact symbol name (e.g., `ValidateToken`). If you are exploring a specific file, you can query its filepath directly (e.g., `geraph query 'src/app.ts' --type file` or `get_neighbors` with `node_id: "src/app.ts"`).
- **Options**:
  - `--type <type>` (e.g., `file`, `function`, `class`, `interface`, `intent`). Use this to resolve naming conflicts (e.g., if there is a function and an interface both named "User").
  - `--source <file>` (e.g., `src/auth/session.ts`). Use this if you only know the symbol name, to ensure Geraph finds the definition in the correct file.
  - `--page <number>` / `--limit <number>`: Paginate through the `incoming` and `outgoing` edges. For MCP tools, pass `page` and `limit` arguments.
- **Why use options?**: Always use `--type` and `--source` if you know them. They strictly reduce token bloat and guarantee you get the exact node you want. Use pagination if `meta.totalPages` is greater than 1 (the default limit is exactly **20** results per page across all tools and commands).

### Step 4: Trace the Context ("The Why")
When you run `query` (or `get_neighbors`), you will see `incoming` and `outgoing` edges.
- **Impact Analysis**: Use `incoming` edges to see who depends on this node.
- **Dependencies**: Use `outgoing` edges to see what this node uses.
- **Pathing**: If you want to know how two nodes are connected, use the `shortest_path` MCP tool.
- **Historical Context ("The Why")**: If you see an `intent` type node connected to your target, **query that `intent` node**. Look at its `metadata.message`. This is a Git commit message that explains *why* the code exists or was changed.

### Step 5: Keep the Graph Current
The graph represents a snapshot in time. If you modify source code, rename files, or commit changes during your session, the graph will become stale.
**You MUST rebuild the graph after making structural changes**. To do this, use the `scan_graph` MCP tool (if available) or run `geraph scan` via the terminal in the workspace root.

---

## CRITICAL RULES

1. **NEVER read `.geraph/graph.json` directly.** It is massive and will overflow your context window. Always use the CLI.
2. **NO EXTRA FLAGS**: There are NO extra or hidden options for `search` or `query`. DO NOT hallucinate flags like `--dfs`. Only use `--type`, `--source`, `--page`, and `--limit`.
3. **COMMAND NOT FOUND**: If the terminal returns a 'command not found' error, you MUST install it globally using `npm install -g geraph` before proceeding.
4. **TERMINAL OUTPUT BUG**: If your terminal fails to capture stdout (e.g., it hangs or returns "No output"), DO NOT GIVE UP. Redirect the output to a file: `geraph query 'Symbol' > .geraph/out.json`, then read that file.
5. **NEVER use `grep`, `rg`, or `find`** for architecture questions when Geraph is available.

---

## JSON Response Interpretation

**`search` output**: Returns an object with `data` (array of matches) and `meta` (pagination details).
- `data[]`: Array of matching node objects.
  - `id`: The unique node identifier. Use this exact string for subsequent `query` calls.
  - `name`: The human-readable name.
  - `type`: The node type (see Glossary below).
  - `file`: The source file.
  - `links`: Total connections. Higher means more architecturally significant.
- `meta`: Contains `page`, `limit`, `total`, `totalPages`. If `page < totalPages`, you can request the next page.

**`query` output**: Returns a detailed object with `target`, `incoming`, `outgoing`, and `meta`:
- `target`: The queried node's full details:
  - `id`, `name`, `type`, `file`, `line`: Identity and location.
  - `metadata.doc`: Contains extracted JSDoc/comments. Read this to understand the purpose and intent of the symbol.
  - `metadata.deprecated`: Boolean flag. If `true`, this symbol is marked `@deprecated`.
  - `metadata.message`: (*Only on `intent` type nodes*) The Git commit message explaining why this node was created or changed.
  - `metadata.author`, `metadata.date`: (*Only on `intent` type nodes*) Commit author and timestamp.
  - `links.incoming` / `links.outgoing`: Count of connections in each direction.
- `incoming`: Array of edges pointing **to** this node. Each entry has `source` (the neighbor node), `relation` (edge type), and `confidence`. Use this for **Impact Analysis** — these are the entities that depend on and will break if you change the target. Note: This array is paginated.
- `outgoing`: Array of edges pointing **out** from this node. Each entry has `target` (the neighbor node), `relation`, and `confidence`. Use this to see what the node **depends on** — what it calls, imports, or references. Note: This array is paginated.
- `meta`: Contains `page`, `limit`, `totalIncoming`, `totalOutgoing`, `totalPages`. If `page < totalPages`, you can request the next page.

### Query Resolution Priority
When you `query` a symbol name (e.g., `geraph query 'userState'`), Geraph resolves it in this strict order:
1. **Exact ID Match**: Perfect match on the unique Node ID.
2. **Case-Sensitive Match**: Matches the exact capitalization (finds the variable `userState` but ignores the interface `UserState`).
3. **Case-Insensitive Fallback**: If no exact case match exists, it returns the case-insensitive match (returns the interface `UserState`).

---

## Geraph Glossary

Use this glossary to understand the types of nodes and edges in the graph, and to accurately choose your `--type` flag for queries.

### Node Types
| Type | Description |
|---|---|
| `file` | A source code file. |
| `function` | A standard function, method, or arrow function. |
| `class` | A class definition. |
| `interface`/`type`/`enum`| TypeScript type definitions. |
| `intent` | A Git commit explaining why a node exists. |

### Edge Types (`relation`)
| Relation | Description |
|---|---|
| `imports` | File A depends on File B. |
| `calls` | Function A executes Function B. |
| `defines` | A file contains a function/class. |
| `references` | A function uses a specific type or interface. |
| `explains` | A Git commit (`intent` node) provides historical context for a specific code node. |

### Confidence Scores
Every edge has a `confidence` level:
| Confidence | Description |
|---|---|
| `EXTRACTED` | 100% deterministic. Found directly by the AST parser (e.g., an explicit function call). |
| `INFERRED` | High probability. Deduced via structural heuristics or indirect relationships. |
| `AMBIGUOUS` | Uncertain connection. Requires human/agent verification. |
