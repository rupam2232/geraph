---
name: graphine
description: "Architectural Knowledge Engine. Navigate the codebase via AST graph."
trigger: /graphine
---

# Graphine Operational Manual

Graphine is an architectural intelligence engine that tracks dependencies, function calls, imports, and historical context (Git commits) across the codebase. It eliminates the need to rely on `grep` or blind text searches.

## How Graphine Works
When executed, Graphine parses the codebase AST (Abstract Syntax Tree) without executing any code. It builds a graph mapping all relationships and outputs its data into the `.graphine/` directory.

### Key Outputs
- **`.graphine/GRAPH_REPORT.md`**: A human-readable architectural summary containing project stats, core architectural pillars ("God Nodes"), and community clustering. **Always read this file first** to understand the high-level architecture before answering complex questions.
- **`.graphine/graph.json`**: The raw serialized graph data used by the CLI.

## Operational Protocol

### 1. Tracing Dependencies (The Query Command)
**CRITICAL RULE**: NEVER attempt to read `.graphine/graph.json` or `.graphine/graph.html` directly. These are massive serialized files. You MUST use the CLI `query` command to fetch crisp, lightweight results.

If you need to know who calls a function, what dependencies a file has, or what a symbol does, use the CLI.
**Syntax**: `npx graphine query '<symbol>'`
- **Mandatory Quoting**: Always wrap the query in single quotes to prevent terminal expansion.
- **Search by Name First**: E.g., `npx graphine query 'saveCache'`.
- **Search by ID Next**: The initial query will return unique IDs (e.g., `src/core/git.ts::saveCache`). For 100% surgical precision in subsequent lookups, query the exact ID.
- **Empty Results**: If a query returns nothing, the symbol does not exist in the scanned scope. Check for typos or try querying the file name instead.

#### Understanding Query Results
The `query` command outputs a JSON object with three main keys:
1. **`target`**: The node you searched for. Pay special attention to the `metadata` object inside it.
   - `metadata.doc`: The full JSDoc block comment for the node. **ALWAYS read this** to understand the "Why" and the intended usage of the function/class.
   - `metadata.deprecated`: If `true`, NEVER use or recommend this node in new code.
   - `line` & `metadata.endLine`: The exact line range of the definition.
2. **`incoming`**: Nodes that depend on the target (e.g., functions that call it, or files that import it).
3. **`outgoing`**: Nodes that the target depends on (e.g., what functions it calls internally).

### 2. After Modifying Code (The Scan Command)
Graphine tracks the codebase statically. If you add, delete, or rename files, functions, or classes, the graph will become out of date.
**Syntax**: `npx graphine scan`
- **When to run**: IMMEDIATELY after you complete any structural modifications or refactoring in the current session. This ensures subsequent queries are accurate.

## Standard Workflows

**Scenario A: "What does this function do?"**
- Run `npx graphine query '<function_name>'`.
- Analyze `outgoing` connections to see its internal dependencies.
- Analyze `incoming` connections to see where it is used.
- Use the `file` and `line` metadata in the output to directly read the implementation.

**Scenario B: "Change this component"**
- Query the component.
- Analyze `incoming` edges to identify all dependents. **You must ensure your changes do not break these callers.**

## Graphine Glossary

### Node Types
- `file`: A source code file.
- `function`: A standard function/method.
- `class`: A class definition.
- `interface` / `type` / `enum`: TypeScript type definitions.
- `[script] filename.ts`: The top-level execution block of a file (code outside any function/class). Query this to see what a file does upon import/execution.
- `intent`: A Git commit explaining why a node exists.

### Edge Types
- `imports`: File A depends on File B.
- `calls`: Function A executes Function B.
- `defines`: A file contains a function/class.
- `references`: A function uses a specific type.
- `explains`: A Git commit provides historical context for a node.

### Confidence Levels
- `EXTRACTED`: Perfect confidence (100%).
- `INFERRED`: High confidence (heuristics).
- `AMBIGUOUS`: Moderate confidence (dynamic calls/overlapping names).
