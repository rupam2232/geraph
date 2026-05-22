import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import path from "path";
import { availableParallelism } from "os";
import { fileURLToPath } from "url";
import { Worker } from "worker_threads";
import { scanDirectory } from "./core/scanner.js";
import { createKnowledgeGraph, resolveCallGraph } from "./core/graph.js";
import { enrichWithGit } from "./core/git.js";
import { analyzeGraph } from "./core/analyze.js";
import {
  WorkerMessage,
  WorkerTask,
  AliasMap,
  PathAlias,
} from "./core/types.js";
import {
  exportGraphJson,
  exportReportMarkdown,
  exportGraphHtml,
} from "./core/serializer.js";
import { installGeraph, uninstallGeraph, PLATFORMS } from "./core/install.js";
import fs from "fs";

function parseTsConfig(
  filePath: string,
  visited = new Set<string>(),
): Record<string, unknown> {
  if (visited.has(filePath)) return {};
  visited.add(filePath);

  if (!fs.existsSync(filePath)) return {};
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const stripped = content.replace(
      /\\"|"(?:\\"|[^"])*"|(\/\/.*|\/\*[\s\S]*?\*\/)/g,
      (m, g) => (g ? "" : m),
    );
    const cleanJson = stripped.replace(/,\s*([\]}])/g, "$1");
    const json = JSON.parse(cleanJson) as Record<string, unknown>;

    let base: Record<string, unknown> = {};
    if (json.extends) {
      const extendsPaths = Array.isArray(json.extends)
        ? json.extends
        : [json.extends];
      for (const extPath of extendsPaths as string[]) {
        let resolvedExtPath = path.resolve(path.dirname(filePath), extPath);
        if (
          !fs.existsSync(resolvedExtPath) &&
          !resolvedExtPath.endsWith(".json")
        ) {
          resolvedExtPath += ".json";
        }
        const extConfig = parseTsConfig(resolvedExtPath, visited);
        base = mergeConfigs(base, extConfig);
      }
    }
    return mergeConfigs(base, json);
  } catch {
    return {};
  }
}

function mergeConfigs(
  base: Record<string, unknown>,
  child: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...base,
    ...child,
    compilerOptions: {
      ...((base.compilerOptions as Record<string, unknown>) || {}),
      ...((child.compilerOptions as Record<string, unknown>) || {}),
    },
  };
}

function buildAliasMap(files: string[]): AliasMap {
  const map: AliasMap = {};
  const configFiles = files.filter(
    (f) => f.endsWith("tsconfig.json") || f.endsWith("jsconfig.json"),
  );

  for (const file of configFiles) {
    const config = parseTsConfig(file);
    const compilerOptions = config.compilerOptions as
      | { paths?: Record<string, string[]>; baseUrl?: string }
      | undefined;
    if (compilerOptions && compilerOptions.paths) {
      const baseUrl = compilerOptions.baseUrl || ".";
      const dir = path.dirname(file);
      const aliases: PathAlias[] = [];
      for (const [key, targets] of Object.entries(compilerOptions.paths)) {
        const prefix = key.replace(/\*$/, "");
        const resolvedTargets = targets.map((t: string) =>
          path.join(dir, baseUrl, t.replace(/\*$/, "")),
        );
        aliases.push({ prefix, targets: resolvedTargets });
      }
      aliases.sort((a, b) => b.prefix.length - a.prefix.length);
      if (aliases.length > 0) {
        map[dir] = aliases;
      }
    }
  }
  return map;
}

export const program = new Command();

program
  .name("geraph")
  .description(chalk.blue("Geraph: Structural memory for AI agents"))
  .version("0.0.0", "-v, --version", "output the current version");

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
      // Optimization: Using Worker Threads to utilize all CPU cores and prevent main-thread freeze.
      spinner.text = chalk.gray(`Parsing AST for ${files.length} files...`);

      const numWorkers = Math.min(availableParallelism(), files.length);
      const workerPath = path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "core",
        "worker.js",
      );

      let parsedCount = 0;
      const workers = Array.from(
        { length: numWorkers },
        () => new Worker(workerPath),
      );
      const queue = [...files];

      await Promise.all(
        workers.map(async (worker) => {
          while (queue.length > 0) {
            const file = queue.shift();
            if (!file) break;

            await new Promise<void>((resolve) => {
              const onMessage = (msg: WorkerMessage) => {
                if (msg.error) {
                  console.error(
                    chalk.yellow(
                      `\n\u26A0\u3000Worker error for ${file}: ${msg.error}`,
                    ),
                  );
                } else {
                  msg.nodes?.forEach((n) => {
                    if (!graph.hasNode(n.id)) {
                      graph.addNode(n.id, n.attr);
                    } else if (n.attr.type !== "file") {
                      // Update attributes if it's not a file (it might have been a ghost node)
                      graph.mergeNodeAttributes(n.id, n.attr);
                    }
                  });
                  msg.edges?.forEach((e) => {
                    if (!graph.hasEdge(e.source, e.target)) {
                      graph.addEdge(e.source, e.target, e.attr);
                    }
                  });
                }
                parsedCount++;
                spinner.text = chalk.gray(
                  `Parsing AST: ${parsedCount}/${files.length} files...`,
                );
                worker.off("message", onMessage);
                worker.off("error", onError);
                resolve();
              };

              const onError = (err: Error) => {
                console.error(
                  chalk.red(`Worker error on ${file}: ${err.message}`),
                );
                parsedCount++;
                worker.off("message", onMessage);
                worker.off("error", onError);
                resolve();
              };

              worker.on("message", onMessage);
              worker.on("error", onError);
              worker.postMessage({
                filePath: file,
                projectRoot: targetDir,
                aliasMap,
              } as WorkerTask);
            });
          }
          // Terminate worker when its part of the queue is empty
          await worker.terminate();
        }),
      );

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
  .action(async (term, options) => {
    const spinner = ora({
      text: chalk.gray(`Searching graph for: ${term}...`),
      color: "blue",
      spinner: "dots",
    }).start();
    try {
      const { searchGraph } = await import("./core/query.js");
      const results = await searchGraph(process.cwd(), term, options.type);
      spinner.stop();
      if (results.length === 0) {
        // Use console.error for all human-readable text instead of console.log.
        // This guarantees that stdout contains ONLY pure JSON data.
        // This allows AI Agents to cleanly redirect output (e.g. `> .geraph/out.json`) without corrupting the JSON.
        console.error(chalk.yellow(`No nodes found matching '${term}'`));
      } else {
        console.log(JSON.stringify(results, null, 2));
        console.error(
          chalk.gray(
            `\nFound ${results.length} nodes. Use 'geraph query <id>' to inspect a specific node.`,
          ),
        );
      }
    } catch (error) {
      spinner.stop();
      console.error(
        chalk.red("?? Search failed:"),
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
