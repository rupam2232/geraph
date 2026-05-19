---
name: geraph
description: "Structural Memory for AI Agents. Navigate the codebase via AST graph."
trigger: /geraph
---

# Geraph Operational Manual

Geraph is a structural memory engine that tracks dependencies, function calls, imports, and historical context (Git commits) across the codebase. It eliminates the need to rely on `grep` or blind text searches.

## How Geraph Works
When executed, Geraph parses the codebase AST (Abstract Syntax Tree) without executing any code. It builds a graph mapping all relationships and outputs its data into the `.geraph/` directory.

### Key Outputs
- **`.geraph/GRAPH_REPORT.md`**: A human-readable architectural summary containing project stats, core architectural pillars ("God Nodes"), and community clustering. **Always read this file first** to understand the high-level architecture. Note that for large projects, this report is truncated to the "Top 100" files and "Top 50" recent commits. Use the `query` command for surgical precision and complete history.
- **`.geraph/graph.html`**: An interactive 2D/3D visualization of the codebase. Useful for humans to spot clusters and flow, but not for AI agents.
- **`.geraph/graph.json`**: The raw serialized graph data. **CRITICAL**: NEVER attempt to read this file directly as it can be massive and will overflow your context window. Always use the `query` command to fetch filtered, token-efficient data.

## Operational Protocol

- **CRITICAL RULE**: NEVER read `.geraph/graph.json` or `.geraph/graph.html` directly. Always use the CLI.
- **COMMAND NOT FOUND**: If the terminal returns a 'command not found' error for any `geraph` command, you MUST install it globally using `npm install -g geraph` before proceeding.
- **TERMINAL OUTPUT BUG**: If your agent environment/terminal fails to capture stdout (e.g., it returns "No output" or the command silently hangs), **DO NOT GIVE UP.** Run the command again and redirect the output to a file inside the `.geraph` directory: `geraph query 'Symbol' > .geraph/out.json`, then read that file. NEVER write output files to the project root.
- **CRITICAL RULE**: DO NOT use `| head` or `| grep`. The CLI is already token-optimized and piping hides crucial error messages.
- **MANDATORY**: You MUST wait for the terminal response after running any Geraph command. Do not hallucinate results.

### Command Reference

| Command | Syntax | When to Use |
|---|---|---|
| **Search** | `geraph search '<term>' [--type <type>]` | For broad/fuzzy discovery. Use when you only know part of a name or want to see all nodes matching a concept (e.g., `search 'auth'`). Returns a lightweight array of matching IDs. |
| **Query** | `geraph query '<symbol>' [--type <type>] [--source <file>]` | For deep inspection. Use when you know the exact ID or exact name of a symbol. Returns full dependencies (`incoming`/`outgoing`) and metadata. |
| **Scan** | `geraph scan` | Run this IMMEDIATELY after you make any type of change in the codebase to ensure the graph is up to date. |

*Note on Flags: All command options/flags are optional, but it is highly recommended to use them if you know the exact type or source, as it guarantees precise results. `--type` and `--source` are the ONLY valid flags. NEVER invent flags like `--limit` or `--dfs`.*

### JSON Response Schema
When you run a command, it returns pure JSON on stdout. Here is how to interpret the fields:

**`search` output**: Returns an array of matching node objects, sorted by connection count (most connected first). Each object contains:
- `id`: The unique node identifier (format: `filePath::symbolName` for code symbols, `commit::hash` for intents, or a raw file path for files).
- `name`: The human-readable name of the symbol.
- `type`: The node type (e.g., `function`, `class`, `interface`, `file`, `intent`).
- `file`: The source file where this node is defined.
- `links`: Total number of connections (incoming + outgoing). Higher means more architecturally significant.

**`query` output**: Returns a detailed object with `target`, `incoming`, and `outgoing`:
- `target`: The queried node's full details:
  - `id`, `name`, `type`, `file`, `line`: Identity and location.
  - `metadata.doc`: Contains extracted JSDoc/comments. Read this to understand the purpose and intent of the symbol.
  - `metadata.deprecated`: Boolean flag. If `true`, this symbol is marked `@deprecated`.
  - `metadata.message`: (*Only on `intent` type nodes*) The Git commit message explaining why this node was created or changed.
  - `metadata.author`, `metadata.date`: (*Only on `intent` type nodes*) Commit author and timestamp.
  - `links.incoming` / `links.outgoing`: Count of connections in each direction.
- `incoming`: Array of edges pointing **to** this node. Each entry has `source` (the neighbor node), `relation` (edge type), and `confidence`. Use this for **Impact Analysis** — these are the entities that depend on and will break if you change the target.
- `outgoing`: Array of edges pointing **out** from this node. Each entry has `target` (the neighbor node), `relation`, and `confidence`. Use this to see what the node **depends on** — what it calls, imports, or references.

### Query Resolution Priority
When you `query` a symbol name (e.g., `geraph query 'userState'`), Geraph resolves it in this strict order:
1. **Exact ID Match**: Perfect match on the unique Node ID.
2. **Case-Sensitive Match**: Matches the exact capitalization (finds the variable `userState` but ignores the interface `UserState`).
3. **Case-Insensitive Fallback**: If no exact case match exists, it returns the case-insensitive match (returns the interface `UserState`).

### Standard Workflows

| Scenario | Action / Command | Why |
|---|---|---|
| **"How does [Concept] work?"** | 1. Read `GRAPH_REPORT.md` to find God Nodes.<br>2. `geraph search '<concept>'` | Geraph is an AST graph. It does not understand English words like 'auth' or 'database'. You MUST use `search` first to find the actual code symbols (e.g. `authSlice.ts`), and then `query` those symbols. NEVER `query` a raw concept. |
| **User mentions a file (e.g. @file:xyz.ts)** | `geraph query '<filepath>' --type file` | ALWAYS query a mentioned file first. Analyzing its `outgoing` connections instantly reveals all classes/functions defined inside it, so you don't have to guess symbol names. |
| **"What does this function do?"**| `geraph query '<funcName>' --type function` | Read `target.metadata.doc` for intent. Look at `outgoing` for what it calls, and `incoming` for who calls it. |
| **"Impact of changing a field/property?"** | `geraph query '<ContainerName>'` | Geraph DOES NOT index individual fields (like `avatar`). You MUST query the Interface/Class that contains the field (e.g., `UserState`), then analyze its `incoming` edges. NEVER query the field name directly. |
| **"Impact of changing a class/function?"** | `geraph query '<symbolName>'` | Analyze the `incoming` array. These are the exact entities that depend on your target and might break. |
| **"Query Failed / Not Found"** | `geraph search '<symbolName>'` | Do NOT fallback to `grep`. If the terminal fails to capture output, redirect to a file (`> .geraph/out.json`) and read it. If it returns a genuine "Not found" error, use the `geraph search` command to find the correct naming. |

### Geraph Glossary

| Node Type | Description |
|---|---|
| `file` | A source code file. |
| `function` | A standard function/method. |
| `class` | A class definition. |
| `interface`/`type`/`enum`| TypeScript type definitions. |
| `[script] <name>` | The top-level execution block of a file (code outside any function/class). |
| `intent` | A Git commit explaining why a node exists. |

| Edge Type | Description |
|---|---|
| `imports` | File A depends on File B. |
| `calls` | Function A executes Function B. |
| `defines` | A file contains a function/class. |
| `references` | A function uses a specific type. |
| `explains` | A Git commit provides historical context for a node. |
