import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import path from "path";
import { scanDirectory } from "./core/scanner.js";
import { extractAst } from "./core/ast.js";
import { createKnowledgeGraph, resolveCallGraph } from "./core/graph.js";
import { enrichWithGit } from "./core/git.js";
import { analyzeGraph } from "./core/analyze.js";
import { buildAliasMap } from "./core/alias.js";
import {
  exportGraphJson,
  exportReportMarkdown,
  exportGraphHtml,
} from "./core/serializer.js";
import { installGeraph, uninstallGeraph, PLATFORMS } from "./core/install.js";
import fs from "fs";

export const program = new Command();

program
  .name("geraph")
  .description(chalk.blue("Geraph: Structural memory for AI agents"))
  .version("0.3.0", "-v, --version", "output the current version");

program
  .command("scan")
  .description("Scan the current directory and build the Knowledge Graph")
  .action(async () => {
    const targetDir = process.cwd();

    const spinner = ora({
      text: chalk.gray(`Scanning codebase in ${targetDir}...`),
      color: "cyan",
      spinner: "dots",
    }).start();

    const startTime = performance.now();

    try {
      // Phase 1: Invoke the File Walker
      const files = await scanDirectory(targetDir);

      // Phase 2: Initialize Knowledge Graph
      spinner.text = chalk.gray("Initializing Knowledge Graph...");
      const graph = createKnowledgeGraph();

      // Seed the graph with file nodes
      for (const file of files) {
        if (!graph.hasNode(file)) {
          graph.addNode(file, {
            type: "file",
            name: path.basename(file),
            file,
            startLine: 0,
            metadata: {
              extension: path.extname(file),
            },
          });
        }
      }

      // Phase 3: Path Aliasing
      spinner.text = chalk.gray("Mapping path aliases...");
      const aliasMap = buildAliasMap(files);

      // Phase 4: AST Parsing
      await extractAst(files, graph, targetDir, aliasMap, spinner);

      spinner.text = chalk.gray("Resolving call graph...");
      // Merges unresolved_fn ghost nodes into real defined functions,
      // eliminating duplicates caused by cross-file call references.
      resolveCallGraph(graph);

      // Phase 5: Temporal Fact Management (Git History)
      spinner.text = chalk.gray(
        "Extracting Temporal Facts from Git history...",
      );
      await enrichWithGit(graph, targetDir);

      // Phase 6: Graph Analysis
      spinner.text = chalk.gray("Analyzing graph structure...");
      const analysis = analyzeGraph(graph);

      // Phase 7: Caveman Mode & Serialization
      spinner.text = chalk.gray("Compressing graph into Caveman Mode...");
      const outDir = path.join(targetDir, ".geraph");
      exportGraphJson(graph, outDir, analysis);
      exportReportMarkdown(graph, outDir, analysis);
      exportGraphHtml(graph, outDir);

      const endTime = performance.now();
      const durationSeconds = ((endTime - startTime) / 1000).toFixed(1);

      spinner.succeed(
        chalk.green(
          `Successfully scanned and parsed ${files.length} target files.`,
        ),
      );

      console.log();
      console.log(chalk.bold("Graph Stats:"));
      console.log(chalk.dim(`  - Nodes: ${graph.order}`));
      console.log(chalk.dim(`  - Edges: ${graph.size}`));
      console.log(chalk.dim(`  - Communities: ${analysis.communities.length}`));
      console.log(chalk.dim(`  - Time:  ${durationSeconds}s`));
      console.log();
      console.log(chalk.cyan(`Type '/geraph' in your AI chat to begin.`));
      console.log(); // Blank line for padding
    } catch (error) {
      spinner.fail(chalk.red("Failed to scan directory."));
      if (error instanceof Error) {
        console.error(chalk.red(`Error: ${error.message}`));
      }
      process.exit(1);
    }
  });

program
  .command("install [platforms...]")
  .description(
    "Install Geraph context rules for AI agents (e.g., antigravity, vscode, claude, cursor)",
  )
  .action(async (platforms: string[]) => {
    const targetDir = process.cwd();
    const results: string[] = [];

    // If no platforms provided, default to 'agents'
    const targets = platforms.length > 0 ? platforms : ["agents"];

    for (const pName of targets) {
      if (!PLATFORMS[pName]) {
        console.log(
          chalk.yellow(`\n\u26A0\u3000Platform '${pName}' is not supported.`),
        );
        console.log(
          chalk.gray(
            `   Run 'geraph install' to install the default AGENTS.md for basic LLM support.\n`,
          ),
        );
        continue;
      }

      const spinner = ora({
        text: chalk.gray(`Installing Geraph rules for ${pName}...`),
        color: "blue",
        spinner: "dots",
      }).start();

      try {
        const platformResults = await installGeraph(targetDir, pName);
        spinner.succeed(chalk.green(`Installed Geraph rules for ${pName}.`));
        console.log();
        platformResults.forEach((r) => console.log(chalk.dim(`  - ${r}`)));
        console.log();
        results.push(...platformResults);
      } catch (error) {
        spinner.fail(chalk.red(`Failed to install rules for ${pName}.`));
        if (error instanceof Error) {
          console.error(chalk.red(`Error: ${error.message}`));
        }
      }
    }

    if (results.length > 0) {
      if (!fs.existsSync(path.join(process.cwd(), ".geraph/graph.json"))) {
        console.log(
          chalk.cyan(
            "Next Step: Run 'geraph scan' to build the graphical knowledge base.",
          ),
        );
        console.log();
      }
    }
  });

program
  .command("uninstall [platforms...]")
  .description("Uninstall Geraph context rules for AI agents")
  .action(async (platforms: string[]) => {
    const targetDir = process.cwd();
    const results: string[] = [];

    // If no platforms provided, uninstall all
    const targets = platforms.length > 0 ? platforms : [undefined];

    for (const pName of targets) {
      if (pName && !PLATFORMS[pName]) {
        console.log(
          chalk.yellow(
            `\n\u26A0\u3000Platform '${pName}' is not recognized. Skipping.\n`,
          ),
        );
        continue;
      }

      const spinner = ora({
        text: chalk.gray(
          pName
            ? `Removing rules for ${pName}...`
            : "Removing all Geraph rules...",
        ),
        color: "red",
        spinner: "dots",
      }).start();

      try {
        const platformResults = await uninstallGeraph(targetDir, pName);
        results.push(...platformResults);
        if (platformResults.length > 0) {
          spinner.succeed(
            chalk.green(
              pName
                ? `Successfully removed rules for ${pName}.`
                : "Successfully removed all Geraph rules.",
            ),
          );
          console.log();
          platformResults.forEach((r) => console.log(chalk.dim(`  - ${r}`)));
          console.log();
        } else {
          spinner.stop();
        }
      } catch (error) {
        spinner.fail(
          chalk.red(`Failed to remove rules for ${pName || "all"}.`),
        );
        if (error instanceof Error) {
          console.error(chalk.red(`Error: ${error.message}`));
        }
      }
    }

    if (results.length === 0) {
      console.log(chalk.yellow("\nNo Geraph rules found to remove.\n"));
    }
  });

program
  .command("search <term>")
  .description("Discover multiple nodes matching a partial term")
  .option(
    "-t, --type <type>",
    "Filter results by node type (e.g., 'interface', 'class', 'function', 'file')",
  )
  .option("-p, --page <number>", "Page number for pagination", "1")
  .option("-l, --limit <number>", "Number of results per page", "20")
  .action(async (term, options) => {
    const spinner = ora({
      text: chalk.gray(`Searching graph for: ${term}...`),
      color: "blue",
      spinner: "dots",
    }).start();
    try {
      const { searchGraph } = await import("./core/query.js");
      const results = await searchGraph(
        process.cwd(),
        term,
        options.type,
        Number(options.page),
        Number(options.limit),
      );
      spinner.stop();
      if (results.data.length === 0) {
        console.error(
          chalk.yellow(
            `No nodes found matching '${term}' on page ${options.page}`,
          ),
        );
      } else {
        console.log(JSON.stringify(results, null, 2));
        console.error(
          chalk.gray(
            `\nFound ${results.meta.total} nodes across ${results.meta.totalPages} pages. Displaying page ${results.meta.page}.`,
          ),
        );
      }
    } catch (error) {
      spinner.stop();
      console.error(
        chalk.red("❌ Search failed:"),
        error instanceof Error ? error.message : String(error),
      );
      process.exit(1);
    }
  });

program
  .command("query <symbol>")
  .description(
    "Query the knowledge graph for a specific symbol's relationships",
  )
  .option(
    "-t, --type <type>",
    "Filter results by node type (e.g., 'interface', 'class', 'function', 'file')",
  )
  .option(
    "-s, --source <path>",
    "Filter results by source file path (e.g., 'auth.ts')",
  )
  .option("-p, --page <number>", "Page number for pagination", "1")
  .option("-l, --limit <number>", "Number of results per page", "20")
  .action(async (symbol, options) => {
    const spinner = ora({
      text: chalk.gray(`Querying relationships for: ${symbol}...`),
      color: "blue",
      spinner: "dots",
    }).start();
    try {
      const { queryGraph } = await import("./core/query.js");
      const result = await queryGraph(
        process.cwd(),
        symbol,
        options.type,
        options.source,
        Number(options.page),
        Number(options.limit),
      );
      spinner.stop();
      console.log(JSON.stringify(result, null, 2));
    } catch (error) {
      spinner.fail(
        chalk.red(
          `Query failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
      process.exit(1);
    }
  });

program
  .command("mcp [dir]")
  .description(
    "Starts the JSON-RPC Model Context Protocol (MCP) server over stdio",
  )
  .action(async (dir) => {
    try {
      const { loadGraph } = await import("./core/query.js");
      const targetDir = dir ? path.resolve(process.cwd(), dir) : process.cwd();
      const graph = loadGraph(targetDir);

      const { runMcpServer } = await import("./core/mcp.js");
      await runMcpServer(graph, targetDir);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });
