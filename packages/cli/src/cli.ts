import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import path from "path";
import { scanDirectory } from "./core/scanner.js";
import { createKnowledgeGraph, resolveCallGraph } from "./core/graph.js";
import { parseFile } from "./parsers/index.js";
import { enrichWithGit } from "./core/git.js";
import {
  exportGraphJson,
  exportReportMarkdown,
  exportGraphHtml,
} from "./core/serializer.js";

export const program = new Command();

program
  .name("graphine")
  .description(chalk.blue("Graphine: Local-first AI context extraction tool"))
  .version("0.0.0");

program
  .command("scan")
  .description("Scan the current directory and build the Knowledge Graph")
  .action(async () => {
    console.log(chalk.cyan("\nGraphine Engine Started\n"));

    const targetDir = process.cwd();

    // Modern loading animation
    const spinner = ora({
      text: chalk.gray(`Scanning codebase in ${targetDir}...`),
      color: "cyan",
      spinner: "dots",
    }).start();

    try {
      // Phase 2: Invoke the File Walker
      const files = await scanDirectory(targetDir);

      // Phase 3: Initialize Knowledge Graph
      spinner.text = chalk.gray("Initializing Knowledge Graph...");
      const graph = createKnowledgeGraph();

      // Seed the graph with file nodes
      for (const file of files) {
        if (!graph.hasNode(file)) {
          graph.addNode(file, {
            type: "file",
            name: path.basename(file),
            metadata: {
              extension: path.extname(file),
            },
          });
        }
      }

      // Phase 4: AST Parsing
      spinner.text = chalk.gray("Parsing AST for codebase relationships...");
      for (const file of files) {
        parseFile(file, graph);
      }

      // Phase 4.5: Call Graph Resolution
      // Merges unresolved_fn ghost nodes into real defined functions,
      // eliminating duplicates caused by cross-file call references.
      spinner.text = chalk.gray("Resolving call graph...");
      resolveCallGraph(graph);

      // Phase 5: Temporal Fact Management (Git History)
      spinner.text = chalk.gray(
        "Extracting Temporal Facts from Git history...",
      );
      await enrichWithGit(graph, targetDir);

      // Phase 6: Caveman Mode & Serialization
      spinner.text = chalk.gray("Compressing graph into Caveman Mode...");
      const outDir = path.join(targetDir, ".graphine");
      exportGraphJson(graph, outDir);
      exportReportMarkdown(graph, outDir);
      exportGraphHtml(graph, outDir);

      spinner.succeed(
        chalk.green(
          `Successfully scanned and parsed ${chalk.bold(files.length)} target files.`,
        ),
      );

      console.log(chalk.gray(`\nGraph Stats:`));
      console.log(chalk.dim(`  - Nodes: ${graph.order}`));
      console.log(chalk.dim(`  - Edges: ${graph.size}`));

      console.log(); // Blank line for padding
    } catch (error) {
      spinner.fail(chalk.red("Failed to scan directory."));
      if (error instanceof Error) {
        console.error(chalk.red(`Error: ${error.message}`));
      }
      process.exit(1);
    }
  });
