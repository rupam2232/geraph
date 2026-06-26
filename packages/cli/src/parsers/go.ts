import Parser from "web-tree-sitter";
type Language = Parser.Language;
type Node = Parser.SyntaxNode;
import fs from "fs";
import path from "path";
import type { MultiDirectedGraph } from "graphology";
import { NodeData, EdgeData, NodeType } from "../core/graph.js";

// Go standard library packages — skip entirely, just like TS skips Node core modules
const GO_STDLIB_PACKAGES = new Set([
  "archive", "bufio", "builtin", "bytes", "cmp", "compress", "container", "context", "crypto",
  "database", "debug", "embed", "encoding", "errors", "expvar",
  "flag", "fmt",
  "go", "hash", "html",
  "image", "index", "internal", "io", "iter",
  "log", "maps", "math", "mime", "net",
  "os", "path", "plugin",
  "reflect", "regexp", "runtime",
  "slices", "sort", "strconv", "strings", "structs", "sync", "syscall",
  "testing", "text", "time",
  "unicode", "unique", "unsafe"
]);

const GO_BUILT_INS = new Set([
  // Built-in functions and types
  "true", "false", "iota", "nil", "append", "cap", "close", "complex", "copy", "delete", "imag", "len", "make", "new",
  "panic", "print", "println", "real", "recover", "complex64", "complex128", "uint8", "uint16", "uint32", "uint64",
  "int8", "int16", "int32", "int64", "float32", "float64", "byte", "rune", "uint", "int", "uintptr", "string", "bool",
  "error", "any", "comparable", "min", "max", "clear",
  // Common method names that should never become standalone graph nodes
  "Error", "String", "Len", "Less", "Swap", "Close", "Read", "Write", "Seek", "Flush",
  "Lock", "Unlock", "RLock", "RUnlock", "Wait", "Signal", "Broadcast", "Done", "Err",
  "Add", "Load", "Store", "CompareAndSwap", "Value", "Reset", "Stop",
  "Marshal", "Unmarshal", "Encode", "Decode",
  "ServeHTTP", "Header", "Body"
]);

interface GoModInfo {
  filePath: string;
  moduleName: string;
}

let goModulesCache: GoModInfo[] | null = null;

function findProjectGoModules(workspaceRoot: string): GoModInfo[] {
  if (goModulesCache) return goModulesCache;
  const modules: GoModInfo[] = [];

  const scanDir = (dir: string, depth: number) => {
    if (depth > 4) return;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      const hasMod = entries.find(e => e.isFile() && e.name === "go.mod");
      if (hasMod) {
        const modPath = path.join(dir, "go.mod");
        const content = fs.readFileSync(modPath, "utf-8");
        const match = content.match(/^\s*module\s+([^\s]+)/m);
        if (match && match[1]) {
          modules.push({ filePath: modPath, moduleName: match[1].trim() });
        }
      }
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules") {
          scanDir(path.join(dir, entry.name), depth + 1);
        }
      }
    } catch {
      // ignore
    }
  };

  scanDir(workspaceRoot, 0);
  goModulesCache = modules;
  return modules;
}

function findGoModAndModule(dir: string): GoModInfo | null {
  let current = dir;
  while (true) {
    const candidate = path.join(current, "go.mod");
    if (fs.existsSync(candidate)) {
      try {
        const content = fs.readFileSync(candidate, "utf-8");
        const match = content.match(/^\s*module\s+([^\s]+)/m);
        if (match && match[1]) {
          return { filePath: candidate, moduleName: match[1].trim() };
        }
      } catch {
        // ignore
      }
      return { filePath: candidate, moduleName: "" };
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

function resolveGoImport(importPath: string, sourceFilePath: string, currentGoMod: GoModInfo | null): string | null {
  const workspaceRoot = process.cwd();
  const projectModules = findProjectGoModules(workspaceRoot);

  for (const mod of projectModules) {
    if (importPath === mod.moduleName || importPath.startsWith(mod.moduleName + "/")) {
      const relativePart = importPath.slice(mod.moduleName.length);
      const resolvedDir = path.join(path.dirname(mod.filePath), relativePart);
      if (fs.existsSync(resolvedDir)) {
        try {
          const files = fs.readdirSync(resolvedDir);
          const goFile = files.find(f => f.endsWith(".go") && !f.endsWith("_test.go"));
          if (goFile) return path.join(resolvedDir, goFile);
        } catch {
          // ignore
        }
        return resolvedDir;
      }
    }
  }

  if (currentGoMod && currentGoMod.moduleName && importPath.startsWith(currentGoMod.moduleName)) {
    const relativePart = importPath.slice(currentGoMod.moduleName.length);
    const resolvedDir = path.join(path.dirname(currentGoMod.filePath), relativePart);
    if (fs.existsSync(resolvedDir)) {
      try {
        const files = fs.readdirSync(resolvedDir);
        const goFile = files.find(f => f.endsWith(".go") && !f.endsWith("_test.go"));
        if (goFile) return path.join(resolvedDir, goFile);
      } catch {
        // ignore
      }
      return resolvedDir;
    }
  }

  return null;
}

function isGoStdlib(importPath: string): boolean {
  const firstPart = importPath.split("/")[0] || importPath;
  return GO_STDLIB_PACKAGES.has(firstPart) || !firstPart.includes(".");
}

function extractGoComment(node: Node): string | undefined {
  const comments: string[] = [];
  let prev = node.previousSibling;
  while (prev && (prev.type === "comment" || prev.type === "line_comment")) {
    comments.unshift(prev.text.replace(/^\/\/|^\/\*|\*\/$/g, "").trim());
    prev = prev.previousSibling;
  }
  return comments.length > 0 ? comments.join("\n") : undefined;
}

const getGoReceiverType = (node: Node): string => {
  if (node.type !== "method_declaration") return "";
  const receiver = node.childForFieldName("receiver");
  if (!receiver) return "";
  let typeName = "";
  const findType = (n: Node) => {
    if (typeName) return;
    if (n.type === "type_identifier") {
      typeName = n.text.trim();
      return;
    }
    for (let i = 0; i < n.namedChildCount; i++) {
      const child = n.namedChild(i);
      if (child) findType(child);
    }
  };
  findType(receiver);
  return typeName;
};

function isLocalDeclaration(startNode: Parser.SyntaxNode | null | undefined, name: string): boolean {
  let current = startNode;
  const checkPattern = (patternNode: Parser.SyntaxNode): boolean => {
    if (patternNode.type === "identifier") {
      return patternNode.text.trim() === name;
    }
    for (let i = 0; i < patternNode.namedChildCount; i++) {
      const child = patternNode.namedChild(i);
      if (child && checkPattern(child)) return true;
    }
    return false;
  };

  while (current) {
    if (
      current.type === "function_declaration" ||
      current.type === "method_declaration" ||
      current.type === "func_literal"
    ) {
      const signature = current.childForFieldName("signature");
      if (signature) {
        const params = signature.childForFieldName("parameters");
        if (params && checkPattern(params)) return true;
        const results = signature.childForFieldName("results");
        if (results && checkPattern(results)) return true;
      }
      if (current.type === "method_declaration") {
        const receiver = current.childForFieldName("receiver");
        if (receiver && checkPattern(receiver)) return true;
      }
    }

    if (current.type === "for_statement") {
      const findLoopVars = (n: Parser.SyntaxNode): boolean => {
        if (n.type === "range_clause" || n.type === "short_var_declaration") {
          const leftNode = n.childForFieldName("left");
          if (leftNode && checkPattern(leftNode)) return true;
        }
        for (let i = 0; i < n.namedChildCount; i++) {
          const child = n.namedChild(i);
          if (child && findLoopVars(child)) return true;
        }
        return false;
      };
      if (findLoopVars(current)) return true;
    }

    if (current.type === "block" || current.type === "source_file") {
      for (let i = 0; i < current.namedChildCount; i++) {
        const statement = current.namedChild(i);
        if (!statement) continue;

        if (statement.type === "short_var_declaration") {
          const left = statement.childForFieldName("left");
          if (left && checkPattern(left)) {
            if (statement.startIndex <= (startNode?.startIndex ?? 0)) return true;
          }
        } else if (statement.type === "var_declaration" || statement.type === "const_declaration") {
          const findVars = (n: Parser.SyntaxNode): boolean => {
            if (n.type === "var_spec" || n.type === "const_spec") {
              const nameNode = n.childForFieldName("name") || n.namedChild(0);
              if (nameNode && checkPattern(nameNode)) return true;
            }
            for (let j = 0; j < n.namedChildCount; j++) {
              const child = n.namedChild(j);
              if (child && findVars(child)) return true;
            }
            return false;
          };
          if (findVars(statement)) {
            if (statement.startIndex <= (startNode?.startIndex ?? 0)) return true;
          }
        }
      }
    }

    current = current.parent;
  }
  return false;
}

function readSourceFile(filePath: string): string {
  const buffer = fs.readFileSync(filePath);
  if (buffer.length >= 2 && buffer[0] === 0xFF && buffer[1] === 0xFE) {
    return buffer.toString("utf16le").replace(/^\uFEFF/, "");
  }
  if (buffer.length >= 2 && buffer[0] === 0xFE && buffer[1] === 0xFF) {
    const swapped = Buffer.alloc(buffer.length);
    for (let i = 0; i < buffer.length - 1; i += 2) {
      swapped[i] = buffer[i + 1]!;
      swapped[i + 1] = buffer[i]!;
    }
    return swapped.toString("utf16le").replace(/^\uFEFF/, "");
  }
  let content = buffer.toString("utf8");
  if (content.startsWith("\uFEFF")) {
    content = content.slice(1);
  }
  return content.replace(/\0/g, "");
}

export function parseGo(
  filePath: string,
  graph: MultiDirectedGraph<NodeData, EdgeData>,
  language: Language
) {
  const parser = new Parser();
  try {
    parser.setLanguage(language);
  } catch {
    return;
  }

  let sourceCode: string;
  try {
    sourceCode = readSourceFile(filePath);
  } catch {
    return;
  }

  const tree = parser.parse(sourceCode);
  if (!tree) return;

  const localDefinitions = new Set<string>();
  const importMap = new Map<string, string>(); // importedName -> importPath
  const localMethodMap = new Map<string, string[]>();
  const goMod = findGoModAndModule(path.dirname(filePath));

  const queryString = `
    (import_spec path: (interpreted_string_literal) @import_path)
    (import_spec name: (package_identifier) @import_alias path: (interpreted_string_literal) @import_path)

    (type_spec name: (type_identifier) @struct_decl type: (struct_type))
    (type_spec name: (type_identifier) @interface_decl type: (interface_type))
    (type_spec name: (type_identifier) @type_decl)

    (function_declaration name: (identifier) @func_decl)
    (method_declaration name: (field_identifier) @method_decl)

    (call_expression function: (identifier) @call_name)
    (call_expression function: (selector_expression operand: (identifier) @call_operand field: (field_identifier) @call_selector))

    (composite_literal (type_identifier) @type_reference)
    (pointer_type (type_identifier) @type_reference)
    (parameter_declaration (type_identifier) @type_reference)
    (var_spec (type_identifier) @type_reference)
    (field_declaration (type_identifier) @type_reference)
  `;

  const query = language.query(queryString);
  const matches = query.matches(tree.rootNode);

  const getEnclosingScopePath = (startNode: Node | null | undefined): string => {
    const pathParts: string[] = [];
    let current = startNode;
    while (current) {
      if (current.type === "function_declaration") {
        const nameNode = current.childForFieldName("name");
        if (nameNode) pathParts.unshift(nameNode.text.trim());
      } else if (current.type === "method_declaration") {
        const nameNode = current.childForFieldName("name");
        const rcvr = getGoReceiverType(current);
        if (nameNode) {
          const fullName = rcvr ? rcvr + "." + nameNode.text.trim() : nameNode.text.trim();
          pathParts.unshift(fullName);
        }
      } else if (current.type === "type_spec") {
        const nameNode = current.childForFieldName("name");
        if (nameNode) pathParts.unshift(nameNode.text.trim());
      }
      current = current.parent;
    }
    return pathParts.join(".");
  };

  // First pass: extract local definitions and imports
  for (const match of matches) {
    let lastImportPath = "";
    for (const capture of match.captures) {
      const node = capture.node;
      const captureName = capture.name;

      if (captureName === "import_path") {
        const importPath = node.text.replace(/"/g, "").trim();
        lastImportPath = importPath;
        const pkgName = importPath.split("/").pop() || importPath;
        if (pkgName && pkgName !== "") {
          importMap.set(pkgName, importPath);
        }
      } else if (captureName === "import_alias") {
        const alias = node.text.trim();
        if (lastImportPath && alias && alias !== "") {
          importMap.set(alias, lastImportPath);
        }
      } else if (
        captureName === "struct_decl" ||
        captureName === "interface_decl" ||
        captureName === "type_decl" ||
        captureName === "func_decl" ||
        captureName === "method_decl"
      ) {
        const symName = node.text.trim();
        if (symName) {
          localDefinitions.add(symName);

          let scopePrefix = "";
          const decl = node.parent || node;
          if (captureName === "method_decl") {
            const receiverType = getGoReceiverType(decl);
            if (receiverType) {
              scopePrefix = receiverType + ".";
            }
          }

          const symId = `${filePath}::${scopePrefix}${symName}`;
          if (captureName === "func_decl" || captureName === "method_decl") {
            if (!localMethodMap.has(symName)) {
              localMethodMap.set(symName, []);
            }
            localMethodMap.get(symName)!.push(symId);
          }
        }
      }
    }
  }

  // Second pass: insert nodes and draw edges
  for (const match of matches) {
    for (const capture of match.captures) {
      const node = capture.node;
      const captureName = capture.name;

      if (
        captureName === "struct_decl" ||
        captureName === "interface_decl" ||
        captureName === "type_decl" ||
        captureName === "func_decl" ||
        captureName === "method_decl"
      ) {
        const symName = node.text.trim();
        if (!symName) continue;

        let scopePrefix = "";
        let declCandidate = node.parent || node;
        if (declCandidate.type === "type_spec" && declCandidate.parent && declCandidate.parent.type === "type_declaration") {
          declCandidate = declCandidate.parent;
        }
        const decl = declCandidate;

        if (captureName === "method_decl") {
          const receiverType = getGoReceiverType(node.parent || node);
          if (receiverType) {
            scopePrefix = receiverType + ".";
          }
        }

        const symId = `${filePath}::${scopePrefix}${symName}`;
        const parentId = scopePrefix ? `${filePath}::${scopePrefix.slice(0, -1)}` : filePath;

        let nodeType: NodeType = "function";
        if (captureName === "struct_decl") nodeType = "struct";
        else if (captureName === "interface_decl") nodeType = "interface";
        else if (captureName === "type_decl") nodeType = "type";

        const doc = extractGoComment(decl);

        const nodeAttrs: NodeData = {
          type: nodeType,
          name: symName,
          file: filePath,
          startLine: decl.startPosition.row + 1,
          metadata: {
            endLine: decl.endPosition.row + 1,
            doc,
            external: false,
            unresolved: false
          }
        };

        if (!graph.hasNode(symId)) {
          graph.addNode(symId, nodeAttrs);
          graph.addEdge(parentId, symId, { type: "defines", confidence: "EXTRACTED" });
        } else {
          graph.mergeNodeAttributes(symId, nodeAttrs);
          if (!graph.hasEdge(parentId, symId)) {
            graph.addEdge(parentId, symId, { type: "defines", confidence: "EXTRACTED" });
          }
        }
      }

      else if (captureName === "import_path") {
        const importPath = node.text.replace(/"/g, "").trim();
        if (importPath === "" || importPath === "." || importPath === "/") continue;

        const resolvedPath = resolveGoImport(importPath, filePath, goMod);
        if (!resolvedPath && isGoStdlib(importPath)) continue;
        const importNodeId = resolvedPath || `import::${importPath}`;
        if (importNodeId === "import::" || importNodeId.trim() === "") continue;

        if (!graph.hasNode(importNodeId)) {
          const nearestLog = goMod && goMod.filePath ? goMod.filePath : filePath;
          graph.addNode(importNodeId, {
            type: "file",
            name: resolvedPath ? path.basename(resolvedPath) : importPath,
            file: resolvedPath || nearestLog || filePath,
            startLine: 0,
            metadata: resolvedPath ? {} : { external: true }
          });
        }

        if (!graph.hasEdge(filePath, importNodeId)) {
          graph.addEdge(filePath, importNodeId, { type: "imports", confidence: "EXTRACTED" });
        }
      }

      else if (captureName === "call_name") {
        const calledName = node.text.trim();
        if (!calledName || GO_BUILT_INS.has(calledName)) continue;
        if (isLocalDeclaration(node, calledName)) continue;

        const callerScope = getEnclosingScopePath(node.parent);
        const callerId = callerScope ? `${filePath}::${callerScope}` : filePath;
        const targets: { id: string; confidence: "EXTRACTED" | "INFERRED" | "AMBIGUOUS" }[] = [];

        if (localDefinitions.has(calledName)) {
          targets.push({
            id: `${filePath}::${calledName}`,
            confidence: "EXTRACTED"
          });
        } else {
          targets.push({
            id: `unresolved::${calledName}`,
            confidence: "AMBIGUOUS"
          });
        }

        for (const target of targets) {
          const isUnresolved = target.id.startsWith("unresolved::");
          const isExternal = target.id.startsWith("import::") || (!isUnresolved && !target.id.startsWith(filePath));
          const callLine = node.startPosition.row + 1;

          if (!graph.hasNode(target.id)) {
            let fileAttr = filePath;
            if (isUnresolved) {
              fileAttr = filePath;
            } else if (target.id.includes("::")) {
              fileAttr = target.id.split("::")[0] || filePath;
            }

            graph.addNode(target.id, {
              type: "function",
              name: calledName,
              file: fileAttr,
              startLine: isExternal ? 0 : callLine,
              metadata: {
                external: isExternal,
                unresolved: isUnresolved,
                endLine: isExternal ? 0 : callLine,
                callerFile: isUnresolved ? filePath : undefined,
                callerLine: isUnresolved ? callLine : undefined
              }
            });
          }

          if (callerId === target.id) continue;
          if (!graph.hasEdge(callerId, target.id)) {
            graph.addEdge(callerId, target.id, { type: "calls", confidence: target.confidence });
          }
        }
      }

      else if (captureName === "call_selector") {
        const methodName = node.text.trim();
        if (!methodName || GO_BUILT_INS.has(methodName)) continue;

        let operandName = "";
        if (node.parent && node.parent.type === "selector_expression") {
          const operandNode = node.parent.childForFieldName("operand");
          if (operandNode) operandName = operandNode.text.trim();
        }

        if (operandName && GO_STDLIB_PACKAGES.has(operandName)) {
          continue;
        }
        if (isLocalDeclaration(node, operandName ? `${operandName}.${methodName}` : methodName)) continue;

        const callerScope = getEnclosingScopePath(node.parent);
        const callerId = callerScope ? `${filePath}::${callerScope}` : filePath;
        const targets: { id: string; confidence: "EXTRACTED" | "INFERRED" | "AMBIGUOUS" }[] = [];

        const importSource = importMap.get(operandName);
        if (importSource) {
          const resolvedSource = resolveGoImport(importSource, filePath, goMod);
          if (!resolvedSource && isGoStdlib(importSource)) continue;
          const targetBase = resolvedSource || `import::${importSource}`;
          targets.push({
            id: `${targetBase}::${methodName}`,
            confidence: "EXTRACTED"
          });
        } else {
          // Fuzzy match on receiver method
          const localMatches = localMethodMap.get(methodName) || [];
          if (localMatches.length === 1 && localMatches[0]) {
            targets.push({
              id: localMatches[0],
              confidence: "INFERRED"
            });
          } else if (localMatches.length > 1) {
            for (const matchId of localMatches) {
              targets.push({
                id: matchId,
                confidence: "AMBIGUOUS"
              });
            }
          } else {
            targets.push({
              id: `unresolved::${methodName}`,
              confidence: "AMBIGUOUS"
            });
          }
        }

        for (const target of targets) {
          const isUnresolved = target.id.startsWith("unresolved::");
          const isExternal = target.id.startsWith("import::") || (!isUnresolved && !target.id.startsWith(filePath));
          const callLine = node.startPosition.row + 1;

          if (!graph.hasNode(target.id)) {
            let fileAttr = filePath;
            if (isUnresolved) {
              fileAttr = filePath;
            } else if (target.id.includes("::")) {
              fileAttr = target.id.split("::")[0] || filePath;
            }

            graph.addNode(target.id, {
              type: "function",
              name: operandName ? `${operandName}.${methodName}` : methodName,
              file: fileAttr,
              startLine: isExternal ? 0 : callLine,
              metadata: {
                external: isExternal,
                unresolved: isUnresolved,
                endLine: isExternal ? 0 : callLine,
                callerFile: isUnresolved ? filePath : undefined,
                callerLine: isUnresolved ? callLine : undefined
              }
            });
          }

          if (callerId === target.id) continue;
          if (!graph.hasEdge(callerId, target.id)) {
            graph.addEdge(callerId, target.id, { type: "calls", confidence: target.confidence });
          }
        }
      }

      else if (captureName === "type_reference") {
        const referencedTypeName = node.text.trim();
        if (!referencedTypeName || GO_BUILT_INS.has(referencedTypeName)) continue;
        if (isLocalDeclaration(node, referencedTypeName)) continue;

        // Skip type references inside method receiver parameters to avoid circular edges or early-match node missing errors
        let inReceiver = false;
        let p = node.parent;
        while (p) {
          if (p.type === "parameter_list" && p.parent?.type === "method_declaration") {
            inReceiver = true;
            break;
          }
          p = p.parent;
        }
        if (inReceiver) continue;

        const callerScope = getEnclosingScopePath(node.parent);
        const callerId = callerScope ? `${filePath}::${callerScope}` : filePath;
        if (!graph.hasNode(callerId)) continue;
        
        let targetId: string;
        if (localDefinitions.has(referencedTypeName)) {
          targetId = `${filePath}::${referencedTypeName}`;
        } else {
          targetId = `unresolved::${referencedTypeName}`;
        }

        const isUnresolved = !localDefinitions.has(referencedTypeName);

        if (!graph.hasNode(targetId)) {
          graph.addNode(targetId, {
            type: "struct",
            name: referencedTypeName,
            file: filePath,
            startLine: node.startPosition.row + 1,
            metadata: {
              external: false,
              unresolved: isUnresolved,
              endLine: node.startPosition.row + 1,
              callerFile: filePath,
              callerLine: node.startPosition.row + 1
            }
          });
        }

        if (callerId === targetId) continue;
        if (!graph.hasEdge(callerId, targetId)) {
          graph.addEdge(callerId, targetId, { type: "references", confidence: isUnresolved ? "AMBIGUOUS" : "EXTRACTED" });
        }
      }
    }
  }
}
