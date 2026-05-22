import fs from "fs";
import path from "path";
import { AliasMap, PathAlias } from "./types.js";

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

export function buildAliasMap(files: string[]): AliasMap {
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
