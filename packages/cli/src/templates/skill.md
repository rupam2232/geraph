---
name: geraph
description: "Structural Memory for AI Agents. Navigate the codebase via AST graph."
trigger: /geraph
---

# Geraph Operational Manual

Geraph is a structural memory engine that tracks dependencies, function calls, imports, and historical context (Git commits) across the codebase. It builds a graph mapping all relationships without executing any code.

## What You Must Do When Invoked

When you need to understand the architecture, find where a component is, or trace dependencies, follow this strict protocol:

### Step 1: Read the Global Architecture Report
Before answering architecture or codebase questions, **always read `.geraph/GRAPH_REPORT.md` first**. It contains project stats, core architectural pillars ("God Nodes"), and community clustering. 

### Step 2: Use `search` for Fuzzy Discovery
If you don't know the exact ID or exact name of a symbol, you MUST use `search` first.
```bash
geraph search '<term>' [--type <type>]
```
- **Inputs**: Use a broad concept, a partial filename, or a partial function name. For example: `search 'auth'`, `search 'database'`, `search 'User'`.
- **Options**: You can filter by `--type file` or `--type function` if you know what you are looking for.
- **Output**: Returns a lightweight list of matching Node IDs, sorted by significance. 

### Step 3: Use `query` for Deep Inspection
Once you have found the exact Node ID or exact Symbol Name from Step 2 (or if the user explicitly provided one), use `query` to fetch its full dependencies.
```bash
geraph query '<symbol_or_id>' [--type <type>] [--source <file>]
```
- **Inputs**: The exact Node ID (e.g., `src/auth/session.ts::ValidateToken`) or the exact symbol name (e.g., `ValidateToken`). If you are exploring a specific file, you can query its filepath directly (e.g., `geraph query 'src/app.ts' --type file`).
- **Options**:
  - `--type <type>` (e.g., `file`, `function`, `class`, `interface`, `intent`). Use this to resolve naming conflicts (e.g., if there is a function and an interface both named "User").
  - `--source <file>` (e.g., `src/auth/session.ts`). Use this if you only know the symbol name, to ensure Geraph finds the definition in the correct file.
- **Why use options?**: Always use `--type` and `--source` if you know them. They strictly reduce token bloat and guarantee you get the exact node you want.

### Step 4: Trace the Context ("The Why")
When you run `query`, you will see `incoming` and `outgoing` edges. 
- **Impact Analysis**: Use `incoming` edges to see who depends on this node.
- **Dependencies**: Use `outgoing` edges to see what this node uses.
- **Historical Context ("The Why")**: If you see an `intent` type node connected to your target, **query that `intent` node**. Look at its `metadata.message`. This is a Git commit message that explains *why* the code exists or was changed.

### Step 5: Keep the Graph Current
Geraph must stay in sync with the codebase.
- You MUST run `geraph scan` after you modify any code files.
- You MUST run `geraph scan` after committing a change to the repository.

---

## CRITICAL RULES

1. **NEVER read `.geraph/graph.json` directly.** It is massive and will overflow your context window. Always use the CLI.
2. **NO EXTRA FLAGS**: There are NO extra or hidden options for `search` or `query`. DO NOT hallucinate flags like `--limit` or `--dfs`. Only use `--type` and `--source`.
3. **COMMAND NOT FOUND**: If the terminal returns a 'command not found' error, you MUST install it globally using `npm install -g geraph` before proceeding.
4. **TERMINAL OUTPUT BUG**: If your terminal fails to capture stdout (e.g., it hangs or returns "No output"), DO NOT GIVE UP. Redirect the output to a file: `geraph query 'Symbol' > .geraph/out.json`, then read that file.
5. **NEVER use `grep`, `rg`, or `find`** for architecture questions when Geraph is available.

---

## JSON Response Interpretation

**`search` output**: Returns an array of matching node objects.
- `id`: The unique node identifier. Use this exact string for subsequent `query` calls.
- `name`: The human-readable name.
- `type`: The node type (see Glossary below).
- `file`: The source file.
- `links`: Total connections. Higher means more architecturally significant.

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
