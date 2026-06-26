---
name: geraph
description: "Structural Memory for AI Agents. Navigate and query the codebase via AST-based semantic knowledge graph."
trigger: /geraph
---

# Geraph Operational Manual

Geraph is a structural memory engine that tracks codebase abstractions, function calls, module imports, and historical context (Git commits). It constructs a semantic knowledge graph mapping all dependencies without executing any code.

As an AI agent, you MUST follow this operational manual to navigate the codebase using Geraph.

---

## 1. Primary Directives & Workflow

When you need to understand the architecture, locate code definitions, trace dependencies, or perform impact analysis, execute these steps:

### Step 0: MCP First, CLI as Fallback
* **MCP Server (Recommended):** If the Geraph MCP server is active, always prioritize Geraph MCP tools and resources over terminal commands.
* **CLI Wrapper:** If MCP is not available, execute the equivalent terminal command: `geraph <command>`.
* **Global Install Rule:** If running any Geraph CLI command returns a 'command not found' error, you MUST first install it globally using:
  ```bash
  npm install -g geraph
  ```
* **Standardized Terminal Bug Fallback:** If the Geraph CLI commands continuously fail to run (e.g. CLI crashes, execution environments fail — **not** "symbol not found" errors):
  1. Immediately check if Geraph MCP is configured. If it is, switch entirely to MCP tools.
  2. If Geraph MCP is **not** configured, immediately stop your work and ask the user to set up the MCP server by following the official documentation at: [https://github.com/rupam2232/geraph#mcp-server-recommended](https://github.com/rupam2232/geraph#mcp-server-recommended)
  3. **CRITICAL:** Do NOT fallback to default general search tools like `grep`, `rg`, or `find`. Halt execution until MCP is set up.

### Step 1: Read the Global Architecture Report / Load Resources
Before answering architecture or codebase questions, **always load the Geraph Report first**. It provides a compact structural overview, including the top files, communities, god nodes, surprising couplings, and temporal commit history.
* **Via MCP:** Read the `geraph://report` resource.
* **Via CLI:** Read the `.geraph/GRAPH_REPORT.md` file directly.

### Critical Rules
> [!IMPORTANT]
> **NEVER Read Raw Graph Files:** You MUST never attempt to view or read the massive `.geraph/graph.json` or `.geraph/graph.html` files directly. Doing so will instantly overflow your context window, bloat token consumption, and freeze or crash your session. Use Geraph's tools or resources to inspect the graph.

> [!IMPORTANT]
> **NEVER Read Cache Files:** You MUST never try to read any files inside the `.geraph/cache` directory (such as `git-cache.json`). These files store massive raw metadata indexes (e.g. Git blame history) that will instantly blow up your context window, waste millions of tokens, and crash your session.

> [!IMPORTANT]
> **Scan on Modification:** Immediately after making any code changes, creating/deleting files, or committing code, you MUST run the `scan_graph` MCP tool or the `geraph scan` CLI command to rebuild the AST graph and sync Geraph's memory with the active state of the code.

> [!TIP]
> **Use Geraph for Navigation and Structure:** Before reading a source code file, always use Geraph tools/commands (like `search_graph`, `get_node`, or `get_neighbors`) to inspect what classes, functions, or imports are inside the file and how they are connected. You MUST only read a raw file from the filesystem when you actually need to see or edit its source code implementation details.

---

## 2. Fuzzy Search & Node ID Resolution Mechanics

To choose the correct search terms and resolve nodes successfully, you must understand how Geraph names nodes and resolves fuzzy inputs:

### A. Deterministic Node ID Format
Every node in Geraph has a unique, deterministic ID generated as follows:
* **For a File Node:** The normalized absolute or relative workspace path to the file.
  - *Example:* `services/billing/invoicing.ts` (or `E:\coding\project\services\billing\invoicing.ts`)
* **For a Symbol/Entity Node (class, function, interface, etc.):** The containing file path followed by `::` and the symbol name.
  - *Format:* `{containing_file_path}::{symbolName}`
  - *Example:* `services/billing/invoicing.ts::InvoiceProcessor`

### B. Fuzzy Resolution Protocol
When you pass a search string to `shortest_path` (or `geraph path`), `get_node` (or `geraph node`), `get_neighbors` (or `geraph neighbors`), or `query_graph` (or `geraph query`), Geraph resolves it using a multi-tiered fuzzy search:
1. **Exact ID Match:** Matches the exact qualified ID first (e.g. `services/billing/invoicing.ts::InvoiceProcessor`).
2. **Exact Symbol Attribute Match:** Matches the raw name attribute exactly (e.g. matching `InvoiceProcessor` to `attr.name === "InvoiceProcessor"`).
3. **Suffix Matching:** Resolves inputs by checking if the Node ID ends with `/{symbol}` (for files) or `::{symbol}` (for members), e.g. querying `invoicing.ts::InvoiceProcessor` or `invoicing.ts/InvoiceProcessor` will resolve successfully.
4. **Case-Insensitive Match:** Repeats all matching tiers case-insensitively (e.g. matching `invoiceprocessor` to `InvoiceProcessor`).
5. **Optional Filters:** In all matching phases, Geraph optionally filters results by AST node `type` (e.g., `function`) and/or containing `source` file path segment if those parameters are explicitly provided.

### C. Geraph MCP Resource Pointers
If MCP is active, you can load these read-only URIs directly as resources to quickly get high-level overviews without running tools:
* `geraph://report` : The complete `.geraph/GRAPH_REPORT.md` file.
* `geraph://stats` : General stats (node/edge/community counts and confidence breakdown).
* `geraph://god-nodes` : Top 10 most-connected core abstractions.
* `geraph://surprises` : Top 10 surprising cross-community couplings.

---

## 3. Navigating with Pagination

To avoid context-window bloat, Geraph enforces strict pagination on all list-based queries. Every paginated tool/command accepts **two optional parameters**:
* `page`: The page number to retrieve (Default: `1`).
* `limit`: The number of items to show per page (Default: `20` for neighbors/searches, `10` for god nodes).

### Understanding the Pagination Payload
When a query returns, inspect the metadata to determine if you need to fetch more pages:

#### For JSON Responses (e.g., `search_graph` or `get_neighbors` MCP/CLI):
Look at the `meta` block:
```json
"meta": {
  "page": 1,
  "limit": 20,
  "total": 97,
  "totalPages": 5
}
```
* **`page`:** The current page you are viewing.
* **`totalPages`:** The total pages available. If `page < totalPages`, you must make subsequent queries with `page: page + 1` to read the remaining data.

#### For Formatted Text Responses (e.g. `god_nodes`, `get_community`, `get_surprises`):
Inspect the bracketed line at the very bottom:
`[Page 1 of 5 | Total: 97 nodes]`
* If the page count is greater than 1, you must increment the `page` argument in your next tool call to view the next chunk of nodes.

---

## 4. Tool & CLI Command Reference

All query parameters are optional and have robust defaults. If you omit an argument, the server resolves it automatically.

### A. Core Discovery & Abstractions

#### 1. Fuzzy Search
Search for nodes by partial symbol name or file path.
* **MCP Tool:** `search_graph`
  - *Parameters:* `name` (Required), `type` (Optional), `page` (Optional), `limit` (Optional)
* **CLI Command:** `geraph search <term>`
  - *Syntax:* `geraph search <term> [--type <type>] [--page <number>] [--limit <number>]`
  - *Example:* `geraph search Invoice --type class --page 1 --limit 10`
* **Returned Fields & Meaning:**
  - `id`: The unique absolute node ID (use this for subsequent deep inspection calls).
  - `name`: Raw symbol name.
  - `type`: Node category (e.g., `class`, `function`).
  - `file`: Containing file path.
  - `links`: Connection count (degree). High degree = high architectural importance.

#### 2. God Nodes
Find the most connected real nodes in the codebase (excluding noise).
* **MCP Tool:** `god_nodes`
  - *Parameters:* `page` (Optional), `limit` (Optional, Default: 10)
* **CLI Command:** `geraph god`
  - *Syntax:* `geraph god [--page <number>] [--limit <number>]`
* **Output Format:**
  `  {index}. {symbol_name} [id: {node_id}] - {degree} edges`

#### 3. Community Nodes
Fetch all nodes clustered within a specific Louvain community ID.
* **MCP Tool:** `get_community`
  - *Parameters:* `community_id` (Required), `page` (Optional), `limit` (Optional, Default: 20)
* **CLI Command:** `geraph community <id>`
  - *Syntax:* `geraph community <id> [--page <number>] [--limit <number>]`
* **Output Format:**
  `  {symbol_name} (type: {node_type}) [id: {node_id}]`

#### 4. Surprising Connections
Fetch surprising cross-community couplings that link independent subsystems.
* **MCP Tool:** `get_surprises`
  - *Parameters:* `page` (Optional), `limit` (Optional, Default: 20)
* **CLI Command:** `geraph surprises`
  - *Syntax:* `geraph surprises [--page <number>] [--limit <number>]`
* **Output Format:**
  `  {source_name} <-> {target_name} [{edge_type}] - {explanation}`

---

### B. Deep Inspection & Traversal

#### 5. Get Node Detail
Fetch metadata for a single specific symbol or file path.
* **MCP Tool:** `get_node`
  - *Parameters:* `symbol` (Required), `type` (Optional), `source` (Optional)
* **CLI Command:** `geraph node <symbol>`
  - *Syntax:* `geraph node <symbol> [--type <type>] [--source <path>]`
  - *Example:* `geraph node InvoiceProcessor --type class --source invoicing.ts`
* **Returned Fields & Meaning:**
  - `id`: Unique absolute identifier.
  - `name`: Symbol name.
  - `type`: Node category.
  - `file`: Containing file path.
  - `line`: Starting line number in the source file.
  - `links.incoming` / `links.outgoing`: Direct dependency counts.
  - `metadata.doc`: Extracted JSDoc/comments (contains design rationale).
  - `metadata.community`: Louvain community ID (cluster subsystem).

#### 6. Get Neighbors
Trace all incoming and outgoing dependencies of a symbol.
* **MCP Tool:** `get_neighbors`
  - *Parameters:* `symbol` (Required), `type` (Optional), `source` (Optional), `page` (Optional), `limit` (Optional, Default: 20)
* **CLI Command:** `geraph neighbors <symbol>`
  - *Syntax:* `geraph neighbors <symbol> [--type <type>] [--source <path>] [--page <number>] [--limit <number>]`
* **Returned Fields & Meaning:**
  - `incoming[]`: Symbols that call, import, or extend this target. Use this for **Impact Analysis** (what will break if you modify this node).
  - `outgoing[]`: Symbols this target calls, imports, or references. Use this to trace **dependency requirements**.
  - `relation`: Nature of connection (e.g. `calls`, `imports`, `defines`).
  - `confidence`: Confidence levels (`EXTRACTED` = 100% AST certain; `INFERRED` = high structural heuristic probability; `AMBIGUOUS` = requires review).

#### 7. Shortest Path
Find the shortest chain of code relationships linking two nodes.
* **MCP Tool:** `shortest_path`
  - *Parameters:* `source` (Required), `target` (Required), `max_hops` (Optional, Default: 8)
* **CLI Command:** `geraph path <source> <target>`
  - *Syntax:* `geraph path <source> <target> [--max-hops <number>]`
  - *Example:* `geraph path InvoiceProcessor DatabaseClient --max-hops 5`
* **Output Format:** Shows hops and directions between nodes:
  `Shortest path (H hops): SourceSymbol --imports--> Middleware <--calls-- DestinationSymbol`

#### 8. Compact Graph Traversal
Runs a localized BFS/DFS crawl fanning out from the most relevant seed nodes to return a compact context map. It supports fuzzy symbol names, lists of keywords, or full natural language questions.
* **MCP Tool:** `query_graph`
  - *Parameters:* `symbol` or `question` (Required), `mode` (Optional, Default: 'bfs'), `depth` (Optional, Default: 3), `token_budget` (Optional, Default: 2000)
* **CLI Command:** `geraph query <symbol-or-question>`
  - *Syntax:* `geraph query <symbol-or-question> [--mode <bfs|dfs>] [--depth <number>] [--budget <number>]`
  - *Example:* `geraph query "how does InvoiceProcessor write to the database" --depth 2 --budget 1500`
* **Output Format:** Compact text map listing traversed nodes (`NODE`) and edges (`EDGE`):
  `NODE server.js [src=packages/services/server.js loc=0 community=2]`
  `EDGE server.js --imports--> invoicing.py`

#### 9. Graph Statistics
Get summary statistics of the graph (node/edge/community counts and confidence breakdown).
* **MCP Tool:** `graph_stats`
  - *Parameters:* None
* **CLI Command:** `geraph stats`
  - *Syntax:* `geraph stats`
* **Output Format:**
  `Nodes: 256`
  `Edges: 798`
  `Communities: 9`
  `EXTRACTED: 80%`
  `INFERRED: 15%`
  `AMBIGUOUS: 5%`

#### 10. Rebuild Graph
Triggers a full scan of the directory to rebuild the knowledge graph.
* **MCP Tool:** `scan_graph`
  - *Parameters:* `force` (Optional boolean, set true to ignore all caches and rebuild from scratch)
* **CLI Command:** `geraph scan`
  - *Syntax:* `geraph scan [--force]`

---

## 5. Geraph Glossary

### AST Node Types
* `file`: A source code file.
* `media`: A media file (image, video, audio, etc.).
* `function`: A function, method, or arrow function definition.
* `class` / `struct`: A class or struct definition.
* `interface` / `type` / `enum` / `trait`: Type, interface, enum, or trait declarations.
* `macro`: A macro definition.
* `intent`: A Git commit explaining why a node exists (query its `metadata.message` for history).

### AST Edge Types (`relation`)
* `imports`: File A depends on File B.
* `calls`: Function/Method A invokes Function/Method B.
* `defines`: File A contains or defines symbol B.
* `references`: A symbol uses a type, interface, or variable.
* `explains`: A Git commit (`intent` node) provides historical context for a specific code node.

### Confidence Scores
Every edge has a `confidence` level:
* `EXTRACTED`: 100% deterministic AST parser extraction (e.g. direct function call or explicit import statement).
* `INFERRED`: Heuristic structural mapping (e.g. matching a method call on a local instance variable to a unique local function definition of the same name).
* `AMBIGUOUS`: Uncertain or unresolved connection (e.g. multiple matching local method candidates exist, or the symbol is completely unresolved).
