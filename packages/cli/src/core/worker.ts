import { parentPort } from "worker_threads";
import { MultiDirectedGraph } from "graphology";
import { NodeData, EdgeData } from "./graph.js";
import { WorkerMessage, WorkerNode, WorkerEdge, WorkerTask } from "./types.js";
import path from "path";
import fs from "fs";
import os from "os";
import https from "https";
import { fileURLToPath } from "url";
import Parser from "web-tree-sitter";
type Language = Parser.Language;
import { parseTypeScript } from "../parsers/typescript.js";
import { parseJson } from "../parsers/json.js";
import { parseMarkdown } from "../parsers/markdown.js";
import { parseMedia } from "../parsers/media.js";
import { parsePython } from "../parsers/python.js";
import { parseGo } from "../parsers/go.js";
import { parseJava } from "../parsers/java.js";
import { parseRust } from "../parsers/rust.js";
import { parseCpp } from "../parsers/cpp.js";

const MEDIA_EXTS = new Set([
  "png", "jpg", "jpeg", "svg", "gif", "webp", 
  "mp4", "webm", "mp3", "wav"
]);

const POLYGLOT_LANG_MAP: Record<string, string> = {
  py: "python",
  java: "java",
  go: "go",
  rs: "rust",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  h: "cpp",
  hpp: "cpp"
};

function getContextualAliases(filePath: string, aliasMap: import("./types.js").AliasMap): import("./types.js").PathAlias[] {
  let current = path.dirname(filePath);
  while (current) {
    const aliases = aliasMap[current];
    if (aliases) return aliases;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return [];
}

let loadedLanguages: {
  typescript: Language;
  tsx: Language;
  javascript: Language;
} | null = null;

let isParserInitialized = false;

async function ensureParserInitialized() {
  if (isParserInitialized) return;
  await Parser.init();
  isParserInitialized = true;
}

async function getPreinstalledLanguages(): Promise<{
  typescript: Language;
  tsx: Language;
  javascript: Language;
}> {
  if (loadedLanguages) return loadedLanguages;

  await ensureParserInitialized();

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const parsersDir = path.join(__dirname, "../parsers");

  const typescript = await Parser.Language.load(path.join(parsersDir, "tree-sitter-typescript.wasm"));
  const tsx = await Parser.Language.load(path.join(parsersDir, "tree-sitter-tsx.wasm"));
  const javascript = await Parser.Language.load(path.join(parsersDir, "tree-sitter-javascript.wasm"));

  loadedLanguages = { typescript, tsx, javascript };
  return loadedLanguages;
}

function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, (response) => {
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400) {
        response.resume();
        file.close();
        let redirectUrl = response.headers.location;
        if (!redirectUrl) {
          reject(new Error("Redirect header missing"));
          return;
        }
        if (redirectUrl.startsWith("/")) {
          const parsedUrl = new URL(url);
          redirectUrl = `${parsedUrl.protocol}//${parsedUrl.host}${redirectUrl}`;
        }
        const resolvedUrl = redirectUrl;
        file.on("close", () => {
          downloadFile(resolvedUrl, dest).then(resolve).catch(reject);
        });
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        file.close();
        fs.unlink(dest, () => {});
        reject(new Error(`Failed to download: ${response.statusCode}`));
        return;
      }
      response.pipe(file);
      file.on("finish", () => {
        file.close();
        resolve();
      });
    }).on("error", (err) => {
      file.close();
      fs.unlink(dest, () => {});
      reject(err);
    });
  });
}

async function getDynamicLanguage(lang: string): Promise<Language | null> {
  await ensureParserInitialized();

  const globalCacheDir = path.join(os.homedir(), ".geraph", "parsers");
  const globalPath = path.join(globalCacheDir, `tree-sitter-${lang}.wasm`);

  // check home directory cache (~/.geraph/parsers/)
  if (fs.existsSync(globalPath)) {
    try {
      return await Parser.Language.load(globalPath);
    } catch {
      try {
        fs.unlinkSync(globalPath);
      } catch {
        // ignore
      }
    }
  }

  if (!fs.existsSync(globalCacheDir)) {
    fs.mkdirSync(globalCacheDir, { recursive: true });
  }

  let tempPath: string | null = null;
  try {
    const url = `https://unpkg.com/tree-sitter-wasms/out/tree-sitter-${lang}.wasm`;
    tempPath = path.join(globalCacheDir, `tree-sitter-${lang}.${Date.now()}.${Math.random().toString(36).substring(2)}.tmp`);

    await downloadFile(url, tempPath);
    if (!fs.existsSync(globalPath)) {
      try {
        fs.renameSync(tempPath, globalPath);
        tempPath = null;
      } catch (err) {
        if (!fs.existsSync(globalPath)) {
          throw err;
        }
      }
    }
    return await Parser.Language.load(globalPath);
  } catch (err) {
    throw new Error(`Failed to download or load parser for ${lang}: ${err}`);
  } finally {
    if (tempPath) {
      try {
        if (fs.existsSync(tempPath)) {
          fs.unlinkSync(tempPath);
        }
      } catch {
        // ignore
      }
    }
  }
}

parentPort?.on("message", async (msg: WorkerTask) => {
  const { filePath, aliasMap } = msg;
  const localGraph = new MultiDirectedGraph<NodeData, EdgeData>();

  try {
    // Seed local graph with the file node itself so parsers can add 'defines' edges
    localGraph.addNode(filePath, {
      type: "file",
      name: path.basename(filePath),
      file: filePath,
      startLine: 0,
      metadata: {
        extension: path.extname(filePath),
      },
    });

    const ext = filePath.split(".").pop()?.toLowerCase() || "";

    if (ext === "ts" || ext === "js" || ext === "tsx" || ext === "jsx") {
      const aliases = getContextualAliases(filePath, aliasMap || {});
      const languages = await getPreinstalledLanguages();
      parseTypeScript(filePath, localGraph, languages, aliases);
    } else if (ext === "json") {
      parseJson(filePath, localGraph);
    } else if (ext === "md") {
      parseMarkdown(filePath, localGraph);
    } else if (MEDIA_EXTS.has(ext)) {
      parseMedia(filePath, localGraph);
    } else if (POLYGLOT_LANG_MAP[ext]) {
      const langName = POLYGLOT_LANG_MAP[ext]!;
      const language = await getDynamicLanguage(langName);
      if (language) {
        if (langName === "python") parsePython(filePath, localGraph, language);
        else if (langName === "go") parseGo(filePath, localGraph, language);
        else if (langName === "java") parseJava(filePath, localGraph, language);
        else if (langName === "rust") parseRust(filePath, localGraph, language);
        else if (langName === "cpp") parseCpp(filePath, localGraph, language);
      }
    } else {
      // Unknown file type is already seeded as 'file' node above
    }

    const nodes: WorkerNode[] = localGraph.nodes().map((id) => ({
      id,
      attr: localGraph.getNodeAttributes(id),
    }));
    const edges: WorkerEdge[] = localGraph.edges().map((id) => ({
      source: localGraph.source(id),
      target: localGraph.target(id),
      attr: localGraph.getEdgeAttributes(id),
    }));

    const response: WorkerMessage = { nodes, edges };
    parentPort?.postMessage(response);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    parentPort?.postMessage({ error: errorMessage });
  }
});
