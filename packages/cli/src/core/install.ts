import fs from "fs";
import path from "path";

export interface InstallOptions {
  platform?: string;
  force?: boolean;
}

const START_MARKER = "<!-- GRAPHINE_START -->";
const END_MARKER = "<!-- GRAPHINE_END -->";

const INSTRUCTIONS_CONTENT = `# 🧠 Graphine Knowledge Engine: Instructions

You are an AI agent with access to a high-fidelity Knowledge Graph of this codebase. 

## 1. Context Entry Points
- **.graphine/GRAPH_REPORT.md**: Read this FIRST. It contains God Nodes and Community structure.
- **.graphine/graph.json**: Raw data for deep relationship queries.

## 2. Your Skillset
1. **Prefer Graph over Grep**: Use edges to understand how components fit together.
2. **Context Stitching**: Use "defines" edges to find symbol definitions.
3. **Temporal Awareness**: Check "intent" nodes for "WHY" context from git history.

## 3. Auto-Maintenance
If you change inheritance or structure, run:
\`\`\`bash
npx graphine scan
\`\`\`
`;

const RULE_CONTENT = `
## Graphine Intelligence
This project has a knowledge graph at .graphine/.
- **Data**: Read .graphine/GRAPH_REPORT.md for architectural pillars and communities.
- **Workflow**: Follow the protocols in .graphine/INSTRUCTIONS.md for searching and navigation.
- **Update**: If structure changes, run \`npx graphine scan\`.
`;

const CLAUDE_SKILL_HEADER = `---
name: graphine
description: "Knowledge Graph Engine for code architecture. Trigger: /graphine"
trigger: /graphine
---

# /graphine

Use this tool to understand the architecture, dependencies, and hidden couplings in the codebase.

## Workflow:
1. Ensure the graph is fresh: \`npx graphine scan\`
2. Read \`.graphine/GRAPH_REPORT.md\` for the high-level architecture.
3. Follow workflow instructions in \`.graphine/INSTRUCTIONS.md\`.
4. Use \`.graphine/graph.json\` for detailed relationship lookups.

`;

interface PlatformConfig {
  name: string;
  file: string;
  isShared: boolean;
  content: string;
}

const PLATFORMS: Record<string, PlatformConfig> = {
  claude: {
    name: "Claude Code",
    file: ".claude/graphine.md",
    isShared: false,
    content: CLAUDE_SKILL_HEADER + RULE_CONTENT,
  },
  cursor: {
    name: "Cursor",
    file: ".cursorrules",
    isShared: true,
    content: RULE_CONTENT,
  },
  antigravity: {
    name: "Antigravity",
    file: "AGENTS.md",
    isShared: true,
    content: RULE_CONTENT,
  },
  vscode: {
    name: "VS Code",
    file: ".vscode/graphine.md",
    isShared: false,
    content: RULE_CONTENT,
  },
  agents: {
    name: "General Agents",
    file: "AGENTS.md",
    isShared: true,
    content: RULE_CONTENT,
  },
  copilot: {
    name: "GitHub Copilot",
    file: ".github/copilot-instructions.md",
    isShared: true,
    content: RULE_CONTENT,
  },
};


function injectContent(existing: string, content: string): string {
  const newSection = `\n${START_MARKER}\n${content.trim()}\n${END_MARKER}\n`;
  const startIdx = existing.indexOf(START_MARKER);
  const endIdx = existing.indexOf(END_MARKER);

  if (startIdx !== -1 && endIdx !== -1) {
    // Replace existing section
    return existing.slice(0, startIdx) + newSection.trim() + existing.slice(endIdx + END_MARKER.length);
  }
  
  // Append to end
  return existing.trim() + "\n\n" + newSection.trim();
}

function removeContent(existing: string): { content: string; wasFound: boolean } {
  const startIdx = existing.indexOf(START_MARKER);
  const endIdx = existing.indexOf(END_MARKER);

  if (startIdx !== -1 && endIdx !== -1) {
    const before = existing.slice(0, startIdx).trim();
    const after = existing.slice(endIdx + END_MARKER.length).trim();
    return { 
      content: (before + (after ? "\n\n" + after : "")).trim(),
      wasFound: true 
    };
  }
  return { content: existing, wasFound: false };
}

export async function installGraphine(targetDir: string, options: InstallOptions) {
  const platformKey = (options.platform || "claude").toLowerCase();
  const config = PLATFORMS[platformKey];
  
  if (!config) {
    throw new Error(`Unsupported platform: ${platformKey}. Supported: ${Object.keys(PLATFORMS).join(", ")}`);
  }

  const results: string[] = [];

  // 1. Ensure .graphine directory exists
  const graphineDir = path.join(targetDir, ".graphine");
  if (!fs.existsSync(graphineDir)) {
    fs.mkdirSync(graphineDir, { recursive: true });
  }

  // 2. Always update the Instructions (Dedicated)
  const instructionsPath = path.join(graphineDir, "INSTRUCTIONS.md");
  fs.writeFileSync(instructionsPath, INSTRUCTIONS_CONTENT, "utf-8");
  results.push(`Updated Instructions: .graphine/INSTRUCTIONS.md`);

  // 3. Install platform-specific rules
  const fullPath = path.join(targetDir, config.file);
  const parentDir = path.dirname(fullPath);
  if (!fs.existsSync(parentDir)) {
    fs.mkdirSync(parentDir, { recursive: true });
  }

  if (config.isShared) {
    let existing = "";
    if (fs.existsSync(fullPath)) {
      existing = fs.readFileSync(fullPath, "utf-8");
    }
    const updated = injectContent(existing, config.content);
    fs.writeFileSync(fullPath, updated, "utf-8");
    results.push(`Injected rules into shared file: ${config.file}`);
  } else {
    fs.writeFileSync(fullPath, config.content.trim(), "utf-8");
    results.push(`Created dedicated rule file: ${config.file}`);
  }

  return results;
}

export async function uninstallGraphine(targetDir: string) {
  const results: string[] = [];

  // 1. Process all potential platforms
  for (const config of Object.values(PLATFORMS)) {
    const fullPath = path.join(targetDir, config.file);
    if (!fs.existsSync(fullPath)) continue;

    if (config.isShared) {
      const existing = fs.readFileSync(fullPath, "utf-8");
      const { content, wasFound } = removeContent(existing);
      
      if (wasFound) {
        if (content.trim() === "") {
          fs.unlinkSync(fullPath);
          results.push(`Deleted empty shared file: ${config.file}`);
        } else {
          fs.writeFileSync(fullPath, content, "utf-8");
          results.push(`Removed Graphine section from: ${config.file}`);
        }
      }
    } else {
      // Dedicated files are deleted entirely
      fs.unlinkSync(fullPath);
      results.push(`Deleted dedicated rule file: ${config.file}`);
    }
  }

  // 2. Delete .graphine/INSTRUCTIONS.md (formerly PLAYBOOK.md)
  const instructionsPath = path.join(targetDir, ".graphine", "INSTRUCTIONS.md");
  if (fs.existsSync(instructionsPath)) {
    fs.unlinkSync(instructionsPath);
    results.push("Deleted Instructions: .graphine/INSTRUCTIONS.md");
  }

  // Also cleanup old PLAYBOOK.md if it exists
  const oldPlaybookPath = path.join(targetDir, ".graphine", "PLAYBOOK.md");
  if (fs.existsSync(oldPlaybookPath)) {
    fs.unlinkSync(oldPlaybookPath);
  }

  return results;
}
