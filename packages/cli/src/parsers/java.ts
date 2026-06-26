import Parser from "web-tree-sitter";
type Language = Parser.Language;
type Node = Parser.SyntaxNode;
import fs from "fs";
import path from "path";
import type { MultiDirectedGraph } from "graphology";
import { NodeData, EdgeData, NodeType } from "../core/graph.js";

// Java standard library packages — skip entirely, just like TS skips Node core modules
const JAVA_STDLIB_PACKAGES = new Set([
  "java", "javax", "jdk", "sun", "com.sun", "org.xml", "org.w3c",
  // java.lang is auto-imported so we cover the most common System/String/etc references
  "System", "Runtime", "Process", "ProcessBuilder",
  // java.util
  "Scanner"
]);

function isJavaStdlib(importPath: string): boolean {
  const firstPart = importPath.split(".")[0] || importPath;
  if (JAVA_STDLIB_PACKAGES.has(firstPart)) return true;
  if (importPath.startsWith("java.") || importPath.startsWith("javax.") ||
      importPath.startsWith("jdk.") || importPath.startsWith("sun.") ||
      importPath.startsWith("com.sun.") || importPath.startsWith("org.xml.") ||
      importPath.startsWith("org.w3c.")) return true;
  return false;
}

const JAVA_BUILT_INS = new Set([
  // Primitives and keywords
  "void", "int", "double", "float", "boolean", "long", "char", "byte", "short", "null", "true", "false", "this", "super",
  // java.lang classes (auto-imported)
  "Object", "Class", "String", "CharSequence", "StringBuilder", "StringBuffer", "System", "Runtime", "Process",
  "Thread", "ThreadGroup", "Runnable", "ThreadLocal", "Math", "StrictMath", "Number", "Byte", "Short", "Integer",
  "Long", "Float", "Double", "Boolean", "Character", "Void", "Throwable", "Error", "Exception", "RuntimeException",
  "IllegalArgumentException", "NullPointerException", "IndexOutOfBoundsException", "UnsupportedOperationException",
  "IllegalStateException", "ClassCastException", "ArithmeticException", "ArrayIndexOutOfBoundsException",
  "StackOverflowError", "OutOfMemoryError", "ClassNotFoundException", "NoSuchMethodException",
  "SecurityException", "ConcurrentModificationException",
  "Iterable", "Cloneable", "Comparable", "AutoCloseable", "Serializable",
  "Enum", "Annotation", "Override", "Deprecated", "SuppressWarnings", "FunctionalInterface",
  // java.util classes & collections (universally known)
  "List", "ArrayList", "LinkedList", "Map", "HashMap", "TreeMap", "LinkedHashMap", "Set", "HashSet", "TreeSet",
  "LinkedHashSet", "Queue", "Deque", "ArrayDeque", "PriorityQueue", "Iterator", "ListIterator", "Collections",
  "Arrays", "Optional", "UUID", "Objects", "Date", "Calendar", "Locale", "Scanner", "Formatter", "Properties",
  "ConcurrentHashMap", "CopyOnWriteArrayList", "Vector", "Stack", "Hashtable",
  "Stream", "Collectors", "Predicate", "Function", "Consumer", "Supplier", "BiFunction", "BiConsumer",
  // Common instance methods that should never be graph nodes
  "print", "println", "printf", "format", "equals", "hashCode", "toString", "clone", "finalize", "wait",
  "notify", "notifyAll", "getClass", "compareTo", "iterator", "size", "isEmpty", "contains", "containsKey",
  "containsValue", "get", "put", "remove", "clear", "add", "addAll", "removeAll", "retainAll",
  "toArray", "stream", "of", "values", "keySet", "entrySet",
  "length", "charAt", "substring", "indexOf", "lastIndexOf", "trim", "split", "replace", "replaceAll",
  "startsWith", "endsWith", "contains", "toLowerCase", "toUpperCase", "matches", "join",
  "append", "insert", "delete", "reverse",
  "parseInt", "parseDouble", "parseLong", "parseFloat", "valueOf",
  "abs", "min", "max", "round", "ceil", "floor", "sqrt", "pow", "random",
  "close", "read", "write", "flush", "available",
  "run", "start", "interrupt", "sleep", "yield", "join",
  "currentTimeMillis", "nanoTime", "gc", "exit", "getProperty", "setProperty",
  "getName", "setName", "getId", "getType", "getValue", "setValue"
]);

let javaSourceDirsCache: string[] | null = null;

function findJavaSourceDirs(workspaceRoot: string): string[] {
  if (javaSourceDirsCache) return javaSourceDirsCache;
  const sourceDirs: string[] = [];

  const scanDir = (dir: string, depth: number) => {
    if (depth > 4) return;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      const hasJavaSrc = entries.find(e => e.isDirectory() && e.name === "src");
      if (hasJavaSrc) {
        const mainJava = path.join(dir, "src", "main", "java");
        if (fs.existsSync(mainJava)) {
          sourceDirs.push(mainJava);
        }
        const src = path.join(dir, "src");
        if (fs.existsSync(src)) {
          sourceDirs.push(src);
        }
      }
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules" && entry.name !== "build" && entry.name !== "target") {
          scanDir(path.join(dir, entry.name), depth + 1);
        }
      }
    } catch {
      // ignore
    }
  };

  scanDir(workspaceRoot, 0);
  sourceDirs.push(path.join(workspaceRoot, "src", "main", "java"));
  sourceDirs.push(path.join(workspaceRoot, "src"));
  sourceDirs.push(workspaceRoot);

  javaSourceDirsCache = [...new Set(sourceDirs)];
  return javaSourceDirsCache;
}

function findNearestJavaDescriptor(dir: string): string {
  let current = dir;
  while (true) {
    for (const name of ["pom.xml", "build.gradle", "settings.gradle"]) {
      const candidate = path.join(current, name);
      if (fs.existsSync(candidate)) return candidate;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return "";
}

function resolveJavaImport(importPath: string): string | null {
  const relativePart = importPath.replace(/\./g, "/");
  const workspaceRoot = process.cwd();
  const sourceDirs = findJavaSourceDirs(workspaceRoot);

  for (const srcDir of sourceDirs) {
    const candidate = path.join(srcDir, relativePart + ".java");
    if (fs.existsSync(candidate)) return candidate;
  }

  const className = importPath.split(".").pop() || importPath;
  if (className && className !== "") {
    const findClassFile = (dir: string, depth: number): string | null => {
      if (depth > 4) return null;
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isFile() && entry.name === className + ".java") {
            return path.join(dir, entry.name);
          }
          if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules" && entry.name !== "build" && entry.name !== "target") {
            const found = findClassFile(path.join(dir, entry.name), depth + 1);
            if (found) return found;
          }
        }
      } catch {
        // ignore
      }
      return null;
    };
    return findClassFile(workspaceRoot, 0);
  }

  return null;
}

function extractJavadoc(node: Node): string | undefined {
  let prev = node.previousSibling;
  while (prev && (prev.type === "modifiers" || prev.type === "annotation" || prev.type === "marker_annotation")) {
    prev = prev.previousSibling;
  }
  if (prev && prev.type === "block_comment" && prev.text.startsWith("/**")) {
    return prev.text
      .replace(/^\/\*\*|\*\/$/g, "")
      .split("\n")
      .map((l: string) => l.replace(/^\s\*\/|^\s*\*\s?|^\s*/, "").trim())
      .filter((l: string) => l)
      .join("\n");
  }
  return undefined;
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
      current.type === "method_declaration" ||
      current.type === "constructor_declaration" ||
      current.type === "lambda_expression"
    ) {
      const params = current.childForFieldName("parameters") || current.namedChildren.find(c => c.type === "formal_parameters");
      if (params && checkPattern(params)) return true;
    }

    if (current.type === "catch_clause") {
      const param = current.childForFieldName("parameter") || current.namedChildren.find(c => c.type === "catch_formal_parameter");
      if (param && checkPattern(param)) return true;
    }

    if (current.type === "for_statement" || current.type === "enhanced_for_statement") {
      const findLoopVars = (n: Parser.SyntaxNode): boolean => {
        if (n.type === "local_variable_declaration" || n.type === "variable_declarator") {
          const nameNode = n.childForFieldName("name") || n.namedChild(0);
          if (nameNode && checkPattern(nameNode)) return true;
        }
        for (let i = 0; i < n.namedChildCount; i++) {
          const child = n.namedChild(i);
          if (child && findLoopVars(child)) return true;
        }
        return false;
      };
      if (findLoopVars(current)) return true;
    }

    if (current.type === "block") {
      for (let i = 0; i < current.namedChildCount; i++) {
        const statement = current.namedChild(i);
        if (!statement) continue;

        if (statement.type === "local_variable_declaration") {
          const findVars = (n: Parser.SyntaxNode): boolean => {
            if (n.type === "variable_declarator") {
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

export function parseJava(
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
  const importMap = new Map<string, string>(); // className -> importPath
  const localMethodMap = new Map<string, string[]>();

  const queryString = `
    (import_declaration (scoped_identifier) @import_source)
    (import_declaration (identifier) @import_source)

    (class_declaration name: (identifier) @class_decl)
    (interface_declaration name: (identifier) @interface_decl)
    (enum_declaration name: (identifier) @enum_decl)
    (annotation_type_declaration name: (identifier) @annotation_decl)

    (method_declaration name: (identifier) @func_decl)
    (constructor_declaration name: (identifier) @func_decl)

    (method_invocation object: (identifier) @method_object name: (identifier) @method_call)
    (method_invocation name: (identifier) @bare_method_call)
    (object_creation_expression type: (type_identifier) @constructor_call)

    (field_declaration type: (type_identifier) @type_reference)
    (formal_parameter type: (type_identifier) @type_reference)
    (local_variable_declaration type: (type_identifier) @type_reference)
  `;

  const query = language.query(queryString);
  const matches = query.matches(tree.rootNode);

  const getEnclosingScopePath = (startNode: Node | null | undefined): string => {
    const pathParts: string[] = [];
    let current = startNode;
    while (current) {
      if (
        current.type === "class_declaration" ||
        current.type === "interface_declaration" ||
        current.type === "enum_declaration" ||
        current.type === "annotation_type_declaration" ||
        current.type === "method_declaration" ||
        current.type === "constructor_declaration"
      ) {
        const nameNode = current.childForFieldName("name");
        if (nameNode) {
          pathParts.unshift(nameNode.text.trim());
        }
      }
      current = current.parent;
    }
    return pathParts.join(".");
  };

  // First pass: extract imports and local definitions
  for (const match of matches) {
    for (const capture of match.captures) {
      const node = capture.node;
      const captureName = capture.name;

      if (captureName === "import_source") {
        const importPath = node.text.trim();
        const className = importPath.split(".").pop() || importPath;
        if (className && className !== "") {
          importMap.set(className, importPath);
        }
      } else if (
        captureName === "class_decl" ||
        captureName === "interface_decl" ||
        captureName === "enum_decl" ||
        captureName === "annotation_decl" ||
        captureName === "func_decl"
      ) {
        const symName = node.text.trim();
        if (symName) {
          localDefinitions.add(symName);

          const scopePrefix = getEnclosingScopePath(node.parent?.parent);
          const symId = scopePrefix ? `${filePath}::${scopePrefix}.${symName}` : `${filePath}::${symName}`;
          if (captureName === "func_decl") {
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
        captureName === "class_decl" ||
        captureName === "interface_decl" ||
        captureName === "enum_decl" ||
        captureName === "annotation_decl" ||
        captureName === "func_decl"
      ) {
        const symName = node.text.trim();
        if (!symName) continue;

        const scopePrefix = getEnclosingScopePath(node.parent?.parent);
        const symId = scopePrefix ? `${filePath}::${scopePrefix}.${symName}` : `${filePath}::${symName}`;
        const parentId = scopePrefix ? `${filePath}::${scopePrefix}` : filePath;

        let nodeType: NodeType = "function";
        if (captureName === "class_decl") nodeType = "class";
        else if (captureName === "interface_decl") nodeType = "interface";
        else if (captureName === "enum_decl") nodeType = "enum";

        const decl = node.parent || node;
        const doc = extractJavadoc(decl);

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

      else if (captureName === "import_source") {
        const importPath = node.text.trim();
        if (importPath === "" || importPath === "." || importPath === "*") continue;

        const resolvedPath = resolveJavaImport(importPath);
        if (!resolvedPath && isJavaStdlib(importPath)) continue;
        const importNodeId = resolvedPath || `import::${importPath}`;
        if (importNodeId === "import::" || importNodeId.trim() === "") continue;

        if (!graph.hasNode(importNodeId)) {
          const nearestDescriptor = findNearestJavaDescriptor(path.dirname(filePath));
          graph.addNode(importNodeId, {
            type: "file",
            name: resolvedPath ? path.basename(resolvedPath) : importPath,
            file: resolvedPath || nearestDescriptor || filePath,
            startLine: 0,
            metadata: resolvedPath ? {} : { external: true }
          });
        }

        if (!graph.hasEdge(filePath, importNodeId)) {
          graph.addEdge(filePath, importNodeId, { type: "imports", confidence: "EXTRACTED" });
        }
      }

      else if (captureName === "bare_method_call" || captureName === "constructor_call") {
        const calledName = node.text.trim();
        if (!calledName || JAVA_BUILT_INS.has(calledName)) continue;
        if (isLocalDeclaration(node, calledName)) continue;

        const callerScope = getEnclosingScopePath(node.parent);
        const callerId = callerScope ? `${filePath}::${callerScope}` : filePath;
        const targets: { id: string; confidence: "EXTRACTED" | "INFERRED" | "AMBIGUOUS" }[] = [];

        const importSource = importMap.get(calledName);
        if (importSource) {
          const resolvedSource = resolveJavaImport(importSource);
          const targetBase = resolvedSource || `import::${importSource}`;
          targets.push({
            id: `${targetBase}::${calledName}`,
            confidence: "EXTRACTED"
          });
        } else if (localDefinitions.has(calledName)) {
          const scopePrefix = getEnclosingScopePath(node.parent?.parent);
          targets.push({
            id: scopePrefix ? `${filePath}::${scopePrefix}.${calledName}` : `${filePath}::${calledName}`,
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
              type: (captureName === "constructor_call" ? "class" : "function"),
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

      else if (captureName === "method_call") {
        const methodName = node.text.trim();
        if (!methodName || JAVA_BUILT_INS.has(methodName)) continue;

        let objectName = "";
        if (node.parent && node.parent.type === "method_invocation") {
          const objectNode = node.parent.childForFieldName("object");
          if (objectNode) objectName = objectNode.text.trim();
        }

        if (objectName && JAVA_STDLIB_PACKAGES.has(objectName)) continue;
        if (isLocalDeclaration(node, objectName ? `${objectName}.${methodName}` : methodName)) continue;

        const callerScope = getEnclosingScopePath(node.parent);
        const callerId = callerScope ? `${filePath}::${callerScope}` : filePath;
        const targets: { id: string; confidence: "EXTRACTED" | "INFERRED" | "AMBIGUOUS" }[] = [];

        const importSource = importMap.get(objectName);
        if (importSource) {
          const resolvedSource = resolveJavaImport(importSource);
          if (!resolvedSource && isJavaStdlib(importSource)) continue;
          const targetBase = resolvedSource || `import::${importSource}`;
          targets.push({
            id: `${targetBase}::${methodName}`,
            confidence: "EXTRACTED"
          });
        } else {
          // Fuzzy match on method definitions in this file
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
              name: objectName ? `${objectName}.${methodName}` : methodName,
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
        if (!referencedTypeName || JAVA_BUILT_INS.has(referencedTypeName)) continue;
        if (isLocalDeclaration(node, referencedTypeName)) continue;

        const callerScope = getEnclosingScopePath(node.parent);
        const callerId = callerScope ? `${filePath}::${callerScope}` : filePath;
        if (!graph.hasNode(callerId)) continue;
        
        let targetId: string;
        const importSource = importMap.get(referencedTypeName);
        if (localDefinitions.has(referencedTypeName)) {
          targetId = `${filePath}::${referencedTypeName}`;
        } else if (importSource) {
          const resolvedSource = resolveJavaImport(importSource) || importSource;
          if (!resolvedSource && isJavaStdlib(importSource)) continue;
          targetId = `${resolvedSource}::${referencedTypeName}`;
        } else {
          targetId = `unresolved::${referencedTypeName}`;
        }

        const isUnresolved = !localDefinitions.has(referencedTypeName) && !importSource;

        if (!graph.hasNode(targetId)) {
          graph.addNode(targetId, {
            type: "class",
            name: referencedTypeName,
            file: filePath,
            startLine: node.startPosition.row + 1,
            metadata: {
              external: !!importSource,
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
