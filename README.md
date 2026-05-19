<h1 align="center">Geraph</h1>

<p align="center">
  <b>Structural memory for AI agents. Build a Knowledge Graph of your codebase</b>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/geraph"><img src="https://img.shields.io/npm/v/geraph" alt="NPM Version"/></a>
  <a href="https://github.com/rupam2232/geraph/blob/main/LICENSE"><img src="https://img.shields.io/github/license/rupam2232/geraph" alt="License"/></a>
  <a href="https://github.com/sponsors/rupam2232"><img src="https://img.shields.io/badge/sponsor-rupam2232-ea4aaa?logo=github-sponsors" alt="Sponsor"/></a>
</p>

Geraph maps your entire codebase (code, relationships, and history) into a structural knowledge graph that AI agents can query instead of blindly grepping through files.

Works in Google Antigravity, Claude Code, Cursor, VS Code Copilot Chat, and GitHub Copilot CLI.

## Installation & Setup
Run the following commands to install geraph cli, platform specific rules and build the graph:

```bash
# 1. Install globally
npm install -g geraph

# 2. Setup your favorite AI assistant
geraph install [platform]

# 3. Map your project
geraph scan
```

> **Note**: Replace `[platform]` with your actual platform name (e.g., `vscode`, `antigravity`, `claude`, `cursor`) from the table below.

That's it. You get three files:

```
.geraph/
├── graph.html       open in any browser — visualize the graph: search, trace call paths, and view node details
├── GRAPH_REPORT.md  the highlights: key architectural pillars, surprising connections, and brief
└── graph.json       the full graph — query it anytime for surgical code modifications
```

Once the scan is complete, you can use the `/geraph` command in your AI assistant's chat to ask architectural questions or assign codebase-wide tasks. The assistant will utilize the `geraph query` command behind the scenes to fetch precise architectural context.

---

## Pick your platform
Connect your AI assistant by installing the context rules and skills for your preferred platform.

| Platform | Command |
|----------|---------|
| Claude Code | `geraph install claude` |
| Cursor | `geraph install cursor` |
| VS Code / Copilot | `geraph install vscode` |
| GitHub Copilot CLI | `geraph install copilot` |
| Google Antigravity | `geraph install antigravity` |
| Generic Agent | `geraph install agents` |

> **Pro Tip**: You can install multiple platforms at once: `geraph install vscode antigravity`

---
## Uninstall

Remove Geraph context rules and skills from your project.

| Platform | Command |
|----------|---------|
| Claude Code | `geraph uninstall claude` |
| Cursor | `geraph uninstall cursor` |
| VS Code / Copilot | `geraph uninstall vscode` |
| GitHub Copilot CLI | `geraph uninstall copilot` |
| Google Antigravity | `geraph uninstall antigravity` |
| All Platforms | `geraph uninstall` |

> **Pro Tip**: You can uninstall multiple platforms at once: `geraph uninstall vscode antigravity`

---

## What's in the report

- **God nodes** — the most-connected architectural pillars in your project. Everything flows through these.
- **Surprising connections** — non-obvious couplings between unrelated modules.
- **Git Intent** — links your code to the "Why" by extracting architectural rationale from your commit history.
- **Semantic JSDoc** — extracts intent, documentation, and `@deprecated` status directly from comments.
- **Confidence tags** — every relationship is marked `EXTRACTED`, `INFERRED`, or `AMBIGUOUS`. You always know what was found vs guessed.

---

## What files it handles

| Type | Extensions |
|------|-----------|
| Code | `.ts .js .tsx .jsx` |
| Docs | `.md .json` |
| Assets | `.png .jpg .jpeg .svg .gif .webp .mp4 .webm .mp3 .wav` |

AST extraction is done locally via tree-sitter.

---

## Common commands

```bash
geraph scan                                    # build graph for the current folder
geraph search '<term>' [--type <type>]         # discover multiple nodes matching a term
geraph query '<symbol>' [--type <type>] [--source <file>] # instant lookup for a symbol's dependencies
geraph install [platform]                      # install geraph rules for a platform
geraph uninstall [platform]                    # remove geraph rules from a project
```

**Options for Search & Query:**
- `--type <type>`: Filter results by node type (e.g., `interface`, `class`, `function`, `file`).
- `--source <file>`: (*Query only*) Filter results by the source file path to resolve ambiguous symbols.

---

## Ignoring files

Geraph automatically respects your `.gitignore` file. Any files or folders ignored by Git will be skipped during the scan.

You can also create a `.geraphignore` file in your project root (using the same syntax as `.gitignore`) to explicitly exclude additional files or folders from the knowledge graph.

---

## Team setup

For small to medium-sized projects, we recommend committing the `.geraph/` folder to Git so everyone on the team starts with the same map.

1. **One person runs `geraph scan`** and commits `.geraph/`.
2. **Everyone pulls** — their assistant reads the graph immediately.
3. **Run `geraph scan` after changes** to keep the architectural memory fresh.

> **Note**: For large-scale projects, the graph data can become quite large. In these cases, it is **not recommended** to share the `.geraph/` folder via version control.

---

## Privacy

- **Local Extraction**: All parsing (AST) and graph building happens entirely on your local machine.
- **Zero Cloud**: Your code never leaves your system. Everything happens inside your machine fully locally. No code, snippets, or metadata are ever sent to a server. There is no Geraph server.
- **No Telemetry**: No usage tracking, no analytics.
