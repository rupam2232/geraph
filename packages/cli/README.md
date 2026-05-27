# Geraph

**Structural memory for AI agents. Navigate your codebase with surgical precision.**

Geraph maps your entire project—files, functions, classes, and relationships—into a semantic knowledge graph that AI agents (like Claude, Antigravity, and Copilot) can query instead of blindly grepping through your code.

## Quick Start

**Prerequisite:** Node.js `>=18.14.0` is required.

Run the following commands to install geraph cli, platform specific rules and build the graph:

```bash
# 1. Install globally
npm install -g geraph

# 2. Setup your favorite AI assistant
geraph install claude  # or antigravity, vscode, cursor

# 3. Map your project
geraph scan
```

## Why Geraph?

- **Structural Memory**: Long-term "architectural intuition" for AI agents.
- **Token Efficiency**: Compact 2KB reports instead of MBs of raw code.
- **AST Precision**: Static analysis (tree-sitter) for absolute accuracy.
- **History Aware**: Integrates Git history to explain the "Why" behind the code.
- **100% Local & Private**: No cloud, no telemetry, no code leaves your machine.

## MCP Server (Recommended)

Geraph features a fully local Model Context Protocol (MCP) server that operates completely over `stdio`. **Using the MCP server is highly recommended** over running terminal CLI commands for LLMs.

**For a project-level local setup:**
Add the following configuration to your MCP-compatible client (e.g. Cursor or Antigravity IDE):

```json
{
  "mcpServers": {
    "geraph": {
      "command": "geraph",
      "args": ["mcp"]
    }
  }
}
```

**For a global setup:**
If you configure the MCP server globally for your IDE, you must tell the server where your project is located. You can do this by setting the `cwd` field to your project path. If your IDE/platform doesn't support the `cwd` field, you can pass the project path as an argument instead:

```json
{
  "mcpServers": {
    "geraph": {
      "command": "geraph",
      "args": [
        "mcp"
      ],
      "cwd": "<path-to-your-project>"
    }
  }
}
```
If cwd is not supported:
```json
{
  "mcpServers": {
    "geraph": {
      "command": "geraph",
      "args": [
        "mcp",
        "<path-to-your-project>"
      ]
    }
  }
}
```

## Detailed Documentation

For a full guide on workflows, agent integration, and advanced features, visit the **[Main Project Documentation](https://github.com/rupam2232/geraph)**.
