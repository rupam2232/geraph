import fs from "fs";
import path from "path";
import os from "os";
import chalk from "chalk";

const START_MARKER = "<!-- GERAPH_START -->";
const END_MARKER = "<!-- GERAPH_END -->";

const SHARED_RULES = `## geraph

This project uses a geraph knowledge graph.

Rules:
- Before answering architecture or codebase questions, read \`.geraph/GRAPH_REPORT.md\` for god nodes and community structure.
- NEVER try to read the massive \`.geraph/graph.json\` file directly. It is for internal CLI use only.
- If the geraph CLI is available, utilize \`npx geraph query "<symbol>"\` for precise architecture navigation instead of falling back to \`grep\`.
- After modifying code files in this session, run \`npx geraph scan\` to keep the graph current.
`;

const COPILOT_RULES = `## geraph

For any question about this repo's architecture, structure, components, or how to add/modify/find code, your **first action must be** to read \`.geraph/GRAPH_REPORT.md\` (if it exists).

Triggers: "how do I...", "where is...", "what does ... do", "add/modify a <component>", "explain the architecture", or anything that depends on how files or classes relate.

After reading the report, answer using the graph context. Only read source files when (a) modifying/debugging specific code, (b) the graph lacks the needed detail, or (c) the graph is missing or stale.

NEVER attempt to read the massive \`.geraph/graph.json\` file directly. Use the CLI instead.
Use \`npx geraph query "<symbol>"\` to trace dependencies, and \`npx geraph scan\` to update the graph after writing code.
`;

const CURSOR_RULE = `---
description: geraph codebase knowledge graph
alwaysApply: true
---

This project uses a geraph knowledge graph.

- Before answering architecture or codebase questions, read .geraph/GRAPH_REPORT.md for god nodes and community structure.
- NEVER try to read the massive \`.geraph/graph.json\` file directly. It is for internal CLI use only.
- For cross-module "how does X relate to Y" questions or dependency tracing, prefer \`npx geraph query "<symbol>"\` over grep — it guarantees precision.
- After modifying code files in this session, run \`npx geraph scan\` to keep the graph current.
`;

const ANTIGRAVITY_WORKFLOW = `---
name: geraph
description: Navigate codebase architecture and dependencies
---

# Workflow: geraph

Follow the geraph skill installed at ~/.agent/skills/geraph/SKILL.md to run queries.
`;

interface LocalFileConfig {
  path: string;
  content?: string;
  inject?: boolean;
}

interface PlatformConfig {
  name: string;
  localFiles: LocalFileConfig[];
  globalPath?: string;
}

export const PLATFORMS: Record<string, PlatformConfig> = {
  claude: {
    name: "Claude Code",
    localFiles: [{ path: "CLAUDE.md", content: SHARED_RULES, inject: true }],
    globalPath: path.join(
      os.homedir(),
      ".claude",
      "skills",
      "geraph",
      "SKILL.md",
    ),
  },
  cursor: {
    name: "Cursor",
    localFiles: [
      {
        path: ".cursor/rules/geraph.mdc",
        content: CURSOR_RULE,
        inject: false,
      },
    ],
  },
  antigravity: {
    name: "Antigravity",
    localFiles: [
      {
        path: ".agent/rules/geraph.md",
        content: SHARED_RULES,
        inject: false,
      },
      {
        path: ".agent/workflows/geraph.md",
        content: ANTIGRAVITY_WORKFLOW,
        inject: false,
      },
    ],
    globalPath: path.join(
      os.homedir(),
      ".agent",
      "skills",
      "geraph",
      "SKILL.md",
    ),
  },
  agents: {
    name: "Generic Agent (Fallback)",
    localFiles: [{ path: "AGENTS.md", content: SHARED_RULES, inject: true }],
  },
  vscode: {
    name: "VS Code / Copilot",
    localFiles: [
      {
        path: ".github/copilot-instructions.md",
        content: COPILOT_RULES,
        inject: true,
      },
    ],
    globalPath: path.join(
      os.homedir(),
      ".copilot",
      "skills",
      "geraph",
      "SKILL.md",
    ),
  },
  copilot: {
    name: "GitHub Copilot",
    localFiles: [
      {
        path: ".github/copilot-instructions.md",
        content: COPILOT_RULES,
        inject: true,
      },
    ],
    globalPath: path.join(
      os.homedir(),
      ".copilot",
      "skills",
      "geraph",
      "SKILL.md",
    ),
  },
};

export interface InstallOptions {
  platforms: string[];
}

export async function installGeraph(
  targetDir: string,
  platformName: string,
): Promise<string[]> {
  const results: string[] = [];
  const platform = PLATFORMS[platformName];
  if (!platform) {
    throw new Error(`Unsupported platform: ${platformName}`);
  }

  // Load the template content (we use our own internal template for all skills)
  const currentFilePath = new URL(import.meta.url).pathname;
  const normalizedPath =
    process.platform === "win32"
      ? currentFilePath.substring(1)
      : currentFilePath;
  const templatePath = path.resolve(
    path.dirname(normalizedPath),
    ".",
    "templates",
    "skill.md",
  );

  let skillContent = "";
  if (fs.existsSync(templatePath)) {
    skillContent = fs.readFileSync(templatePath, "utf-8");
  }

  // 1. Handle Local Installation (The Project Rule)
  for (const localFile of platform.localFiles) {
    const fullPath = path.join(targetDir, localFile.path);
    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    if (localFile.inject) {
      const injection = `\n${START_MARKER}\n${(localFile.content || skillContent).trim()}\n${END_MARKER}\n`;

      if (fs.existsSync(fullPath)) {
        let content = fs.readFileSync(fullPath, "utf-8");
        const startIndex = content.indexOf(START_MARKER);
        const endIndex = content.indexOf(END_MARKER);

        if (startIndex !== -1 && endIndex !== -1) {
          content =
            content.substring(0, startIndex) +
            injection.trim() +
            content.substring(endIndex + END_MARKER.length);
          fs.writeFileSync(fullPath, content);
          results.push(`${localFile.path} updated (existing section replaced)`);
        } else {
          fs.writeFileSync(fullPath, content.trim() + "\n" + injection);
          results.push(`${localFile.path} updated (section appended)`);
        }
      } else {
        fs.writeFileSync(fullPath, injection);
        results.push(`${localFile.path} created`);
      }
    } else {
      // Overwrite entirely
      fs.writeFileSync(fullPath, localFile.content || "");
      results.push(`${localFile.path} created/updated`);
    }
  }

  // 2. Handle Global Installation (The Slash Command)
  if (skillContent && platform.globalPath) {
    const globalDir = path.dirname(platform.globalPath);
    if (!fs.existsSync(globalDir)) {
      fs.mkdirSync(globalDir, { recursive: true });
    }
    fs.writeFileSync(platform.globalPath, skillContent);
    results.push(`Global skill installed at ${platform.globalPath}`);
  } else if (!skillContent && platform.globalPath) {
    console.log(
      chalk.red(`Failed to install global skill at ${platform.globalPath}.`),
    );
  }

  return results;
}

export async function uninstallGeraph(
  targetDir: string,
  platformName?: string,
): Promise<string[]> {
  const results: string[] = [];

  let platformsToUninstall: PlatformConfig[] = [];
  if (platformName) {
    const p = PLATFORMS[platformName];
    if (p) platformsToUninstall.push(p);
  } else {
    platformsToUninstall = Object.values(PLATFORMS);
  }

  if (platformName && platformsToUninstall.length === 0) {
    throw new Error(`Unsupported platform: ${platformName}`);
  }
  for (const platform of platformsToUninstall) {
    // Clean local files
    for (const localFile of platform.localFiles) {
      const fullPath = path.join(targetDir, localFile.path);
      if (fs.existsSync(fullPath)) {
        if (localFile.inject) {
          const content = fs.readFileSync(fullPath, "utf-8");
          const startIndex = content.indexOf(START_MARKER);
          const endIndex = content.indexOf(END_MARKER);

          if (startIndex !== -1 && endIndex !== -1) {
            const before = content.substring(0, startIndex).trim();
            const after = content
              .substring(endIndex + END_MARKER.length)
              .trim();
            const cleaned = (before + "\n\n" + after).trim();

            if (cleaned === "") {
              fs.unlinkSync(fullPath);
              results.push(`${localFile.path} deleted (empty after cleanup)`);
            } else {
              fs.writeFileSync(fullPath, cleaned + "\n");
              results.push(
                `${localFile.path} cleaned (geraph section removed)`,
              );
            }
          }
        } else {
          // If it was overwritten entirely, just delete it
          fs.unlinkSync(fullPath);
          results.push(`${localFile.path} deleted`);
        }
      }
    }

    // Clean global files unconditionally since global logic relies entirely on the path existing
    if (platform.globalPath && fs.existsSync(platform.globalPath)) {
      fs.unlinkSync(platform.globalPath);
      results.push(`Global skill removed from ${platform.globalPath}`);

      // Cleanup empty parent directories, strictly only for "geraph" directories
      let currentDir = path.dirname(platform.globalPath);
      while (currentDir !== os.homedir()) {
        if (path.basename(currentDir) !== "geraph") {
          break; // Stop cleaning up to avoid deleting ~/.agents or ~/.claude
        }
        try {
          if (fs.readdirSync(currentDir).length === 0) {
            fs.rmdirSync(currentDir);
            currentDir = path.dirname(currentDir);
          } else {
            break;
          }
        } catch {
          break;
        }
      }
    }
  }

  return results;
}
