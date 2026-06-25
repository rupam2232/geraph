import { parentPort } from "worker_threads";
import { EdgeData, createKnowledgeGraph } from "./graph.js";
import { WorkerMessage, WorkerNode, WorkerEdge, WorkerTask } from "./types.js";
import path from "path";
import fs from "fs";
import os from "os";
import https from "https";
import { fileURLToPath } from "url";
import Parser from "web-tree-sitter";
import crypto from "crypto";
type Language = Parser.Language;


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

const AST_CACHE_VERSION = "2"; // Increment this when parsers, rules, or supported languages change!

function stripMarkdownFrontmatter(content: Buffer): Buffer {
  const text = content.toString("utf8");
  if (text.startsWith("---")) {
    const end = text.indexOf("\n---", 3);
    if (end !== -1) {
      return Buffer.from(text.slice(end + 4));
    }
  }
  return content;
}

function calculateFileHash(
  filePath: string,
  projectRoot: string,
  aliasMap: import("./types.js").AliasMap,
): string {
  const content = fs.readFileSync(filePath);
  const relPath = path.relative(projectRoot, filePath).toLowerCase();
  const ext = filePath.split(".").pop()?.toLowerCase() || "";

  const h = crypto.createHash("sha256");
  h.update(Buffer.from(AST_CACHE_VERSION));
  h.update(Buffer.from("\x00"));

  if (ext === "md") {
    const cleanContent = stripMarkdownFrontmatter(content);
    h.update(cleanContent);
    h.update(Buffer.from("\x00"));
    h.update(Buffer.from(relPath));
  } else if (ext === "ts" || ext === "js" || ext === "tsx" || ext === "jsx") {
    h.update(content);
    h.update(Buffer.from("\x00"));
    h.update(Buffer.from(relPath));
    h.update(Buffer.from("\x00"));
    h.update(Buffer.from(JSON.stringify(aliasMap)));
  } else {
    h.update(content);
    h.update(Buffer.from("\x00"));
    h.update(Buffer.from(relPath));
  }

  return h.digest("hex");
}

parentPort?.on("message", async (msg: WorkerTask) => {
  const { filePath, projectRoot, aliasMap, action, cachePath } = msg;

  if (action === "load-cache") {
    try {
      if (!cachePath) throw new Error("cachePath is required for load-cache action");
      const cachedRaw = fs.readFileSync(cachePath, "utf-8");
      const cached = JSON.parse(cachedRaw) as {
        nodes?: WorkerNode[];
        edges?: WorkerEdge[];
      };
      parentPort?.postMessage({
        nodes: cached.nodes || [],
        edges: cached.edges || []
      } satisfies WorkerMessage);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      parentPort?.postMessage({ error: errorMessage });
    }
    return;
  }

  const localGraph = createKnowledgeGraph();

  const originalAddEdge = localGraph.addEdge.bind(localGraph);
  localGraph.addEdge = (source: string, target: string, attr?: EdgeData): string => {
    if (source === target) return "";
    if (!localGraph.hasNode(source)) {
      let fileAttr = filePath;
      let nameAttr = source;
      if (source.includes("::")) {
        const parts = source.split("::");
        fileAttr = parts[0] || filePath;
        nameAttr = parts.slice(1).join("::");
      }
      localGraph.addNode(source, {
        type: "function",
        name: nameAttr,
        file: fileAttr,
        startLine: 0,
        metadata: { placeholder: true }
      });
    }
    if (!localGraph.hasNode(target)) {
      let fileAttr = filePath;
      let nameAttr = target;
      if (target.includes("::")) {
        const parts = target.split("::");
        fileAttr = parts[0] || filePath;
        nameAttr = parts.slice(1).join("::");
      }
      localGraph.addNode(target, {
        type: "function",
        name: nameAttr,
        file: fileAttr,
        startLine: 0,
        metadata: { placeholder: true }
      });
    }
    return originalAddEdge(source, target, attr);
  };

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
      const { parseTypeScript } = await import("../parsers/typescript.js");
      parseTypeScript(filePath, localGraph, languages, aliases);
    } else if (ext === "json") {
      const { parseJson } = await import("../parsers/json.js");
      parseJson(filePath, localGraph);
    } else if (ext === "md") {
      const { parseMarkdown } = await import("../parsers/markdown.js");
      parseMarkdown(filePath, localGraph);
    } else if (MEDIA_EXTS.has(ext)) {
      const { parseMedia } = await import("../parsers/media.js");
      parseMedia(filePath, localGraph);
    } else if (POLYGLOT_LANG_MAP[ext]) {
      const langName = POLYGLOT_LANG_MAP[ext]!;
      const language = await getDynamicLanguage(langName);
      if (language) {
        if (langName === "python") {
          const { parsePython } = await import("../parsers/python.js");
          parsePython(filePath, localGraph, language);
        } else if (langName === "go") {
          const { parseGo } = await import("../parsers/go.js");
          parseGo(filePath, localGraph, language);
        } else if (langName === "java") {
          const { parseJava } = await import("../parsers/java.js");
          parseJava(filePath, localGraph, language);
        } else if (langName === "rust") {
          const { parseRust } = await import("../parsers/rust.js");
          parseRust(filePath, localGraph, language);
        } else if (langName === "cpp") {
          const { parseCpp } = await import("../parsers/cpp.js");
          parseCpp(filePath, localGraph, language);
        }
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

    let hash: string | undefined;
    if (action === "parse" && projectRoot) {
      try {
        hash = calculateFileHash(filePath, projectRoot, aliasMap);
        const astCacheDir = path.join(projectRoot, ".geraph", "cache", "ast");
        if (!fs.existsSync(astCacheDir)) {
          fs.mkdirSync(astCacheDir, { recursive: true });
        }
        const targetCachePath = path.join(astCacheDir, `${hash}.json`);
        const tempPath = path.join(astCacheDir, `${hash}.${Date.now()}.${Math.random().toString(36).substring(2)}.tmp`);
        
        fs.writeFileSync(tempPath, JSON.stringify({ nodes, edges }));
        try {
          fs.renameSync(tempPath, targetCachePath);
        } catch {
          // Windows locks fallback
          try {
            fs.copyFileSync(tempPath, targetCachePath);
            fs.unlinkSync(tempPath);
          } catch {
            // ignore fallback copy failure
          }
        }
      } catch {
        // ignore caching failure
      }
    }

    const response: WorkerMessage = { nodes, edges, hash };
    parentPort?.postMessage(response);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    parentPort?.postMessage({ error: errorMessage });
  }
});
