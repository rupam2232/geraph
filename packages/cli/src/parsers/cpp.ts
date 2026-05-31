import Parser from "web-tree-sitter";
type Language = Parser.Language;
type Node = Parser.SyntaxNode;
import fs from "fs";
import path from "path";
import type { MultiDirectedGraph } from "graphology";
import { NodeData, EdgeData, NodeType } from "../core/graph.js";

// C++ standard library headers — skip entirely, just like TS skips Node core modules
const CPP_STDLIB_HEADERS = new Set([
  // C++ standard library headers (angle-bracket includes)
  "algorithm", "any", "array", "atomic", "barrier", "bit", "bitset",
  "cassert", "cctype", "cerrno", "cfenv", "cfloat", "charconv", "chrono", "cinttypes",
  "climits", "clocale", "cmath", "codecvt", "compare", "complex", "concepts",
  "condition_variable", "coroutine", "csetjmp", "csignal", "cstdarg", "cstddef",
  "cstdint", "cstdio", "cstdlib", "cstring", "ctime", "cuchar", "cwchar", "cwctype",
  "deque", "exception", "execution", "expected",
  "filesystem", "format", "forward_list", "fstream", "functional", "future",
  "generator",
  "initializer_list", "iomanip", "ios", "iosfwd", "iostream", "istream", "iterator",
  "latch", "limits", "list", "locale",
  "map", "mdspan", "memory", "memory_resource", "mutex",
  "new", "numbers", "numeric",
  "optional", "ostream",
  "print",
  "queue",
  "random", "ranges", "ratio", "regex",
  "scoped_allocator", "semaphore", "set", "shared_mutex", "source_location", "span",
  "spanstream", "sstream", "stack", "stacktrace", "stdexcept", "stdfloat",
  "stop_token", "streambuf", "string", "string_view", "strstream", "syncstream",
  "system_error",
  "thread", "tuple", "type_traits", "typeindex", "typeinfo",
  "unordered_map", "unordered_set", "utility",
  "valarray", "variant", "vector", "version",
  // C standard library headers
  "assert.h", "complex.h", "ctype.h", "errno.h", "fenv.h", "float.h", "inttypes.h",
  "iso646.h", "limits.h", "locale.h", "math.h", "setjmp.h", "signal.h", "stdalign.h",
  "stdarg.h", "stdatomic.h", "stdbool.h", "stddef.h", "stdint.h", "stdio.h", "stdlib.h",
  "stdnoreturn.h", "string.h", "tgmath.h", "threads.h", "time.h", "uchar.h", "wchar.h", "wctype.h",
  // POSIX headers
  "unistd.h", "fcntl.h", "sys/types.h", "sys/stat.h", "sys/socket.h", "netinet/in.h",
  "arpa/inet.h", "pthread.h", "dirent.h", "dlfcn.h"
]);

function isStdlibInclude(includePath: string): boolean {
  if (includePath.startsWith("<") && includePath.endsWith(">")) return true;
  const cleanPath = includePath.replace(/^[<"]|[>"]$/g, "");
  return CPP_STDLIB_HEADERS.has(cleanPath);
}

const CPP_BUILT_INS = new Set([
  // Primitive types
  "int", "float", "double", "char", "bool", "void", "size_t", "nullptr", "true", "false", "this",
  "auto", "const", "static", "extern", "volatile", "mutable", "register", "inline", "virtual",
  // Standard library containers & smart pointers (class names)
  "vector", "string", "map", "set", "list", "unordered_map", "unordered_set", "shared_ptr", "unique_ptr",
  "make_shared", "make_unique", "weak_ptr", "array", "deque", "stack", "queue", "priority_queue", "pair", "tuple",
  "optional", "variant", "any", "span", "string_view", "bitset", "forward_list", "multimap", "multiset",
  // I/O & utility (always skip)
  "cout", "cin", "cerr", "clog", "endl", "printf", "scanf", "std", "main",
  "getline", "ignore", "peek", "putback", "get", "put",
  // Common methods that should never be standalone graph nodes
  "size", "length", "empty", "push_back", "pop_back", "push_front", "pop_front",
  "begin", "end", "cbegin", "cend", "rbegin", "rend",
  "front", "back", "at", "data",
  "find", "count", "contains", "erase", "insert", "emplace", "emplace_back",
  "sort", "min", "max", "abs", "swap", "move", "forward",
  "to_string", "stoi", "stod", "stof", "stol", "stoll", "stoul", "stoull",
  "reserve", "resize", "capacity", "shrink_to_fit", "clear", "assign",
  "substr", "c_str", "append", "compare", "replace", "rfind", "find_first_of", "find_last_of",
  "open", "close", "read", "write", "flush", "good", "eof", "fail", "bad",
  "lock", "unlock", "try_lock", "join", "detach",
  "reset", "release", "use_count", "expired",
  // Casts and keywords
  "sizeof", "alignof", "decltype", "typeid", "static_cast", "dynamic_cast", "const_cast", "reinterpret_cast",
  "static_assert", "throw", "new", "delete"
]);

function findNearestCppDescriptor(dir: string): string {
  let current = dir;
  while (true) {
    for (const name of ["CMakeLists.txt", "Makefile", "configure.ac", "meson.build"]) {
      const candidate = path.join(current, name);
      if (fs.existsSync(candidate)) return candidate;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return "";
}

function resolveCppInclude(includeText: string, sourceFilePath: string): string | null {
  const cleanPath = includeText.replace(/^[<"]|[>"]$/g, "");
  const sourceDir = path.dirname(sourceFilePath);

  const relativePath = path.resolve(sourceDir, cleanPath);
  if (fs.existsSync(relativePath)) return relativePath;

  const workspaceRoot = process.cwd();
  const candidates = [
    path.resolve(workspaceRoot, cleanPath),
    path.resolve(workspaceRoot, "include", cleanPath),
    path.resolve(workspaceRoot, "src", cleanPath)
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function extractCppComment(node: Node): string | undefined {
  const comments: string[] = [];
  let prev = node.previousSibling;
  while (prev && (prev.type === "template_parameter_list" || prev.type === "storage_class_specifier")) {
    prev = prev.previousSibling;
  }
  while (prev && (prev.type === "comment" || prev.type === "line_comment")) {
    comments.unshift(prev.text.replace(/^\/\/|^\/\*|\*\/$/g, "").trim());
    prev = prev.previousSibling;
  }
  return comments.length > 0 ? comments.join("\n") : undefined;
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

export function parseCpp(
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
  const localMethodMap = new Map<string, string[]>();

  const queryString = `
    (preproc_include path: (_) @include_path)

    (class_specifier name: (type_identifier) @class_decl)
    (struct_specifier name: (type_identifier) @struct_decl)

    (function_declarator declarator: (identifier) @func_decl)
    (function_declarator declarator: (field_identifier) @func_decl)
    (function_declarator declarator: (qualified_identifier) @qualified_func_decl)

    (call_expression function: (identifier) @call_name)
    (call_expression function: (field_expression field: (field_identifier) @method_call))

    (type_identifier) @type_reference
  `;

  const query = language.query(queryString);
  const matches = query.matches(tree.rootNode);

  const getEnclosingScopePath = (startNode: Node | null | undefined): string => {
    const pathParts: string[] = [];
    let current = startNode;
    while (current) {
      if (
        current.type === "class_specifier" ||
        current.type === "struct_specifier" ||
        current.type === "namespace_definition"
      ) {
        const nameNode = current.childForFieldName("name");
        if (nameNode) {
          pathParts.unshift(nameNode.text.trim());
        }
      } else if (current.type === "function_definition") {
        const decl = current.childForFieldName("declarator");
        if (decl) {
          const nameNode = decl.childForFieldName("declarator");
          if (nameNode) {
            pathParts.unshift(nameNode.text.trim());
          }
        }
      }
      current = current.parent;
    }
    return pathParts.join(".");
  };

  // First pass: extract definitions
  for (const match of matches) {
    for (const capture of match.captures) {
      const captureName = capture.name;

      if (
        captureName === "class_decl" ||
        captureName === "struct_decl" ||
        captureName === "func_decl"
      ) {
        const symName = capture.node.text.trim();
        if (symName) {
          localDefinitions.add(symName);

          const scopePrefix = getEnclosingScopePath(capture.node.parent?.parent?.parent);
          const symId = scopePrefix ? `${filePath}::${scopePrefix}.${symName}` : `${filePath}::${symName}`;
          if (captureName === "func_decl") {
            if (!localMethodMap.has(symName)) {
              localMethodMap.set(symName, []);
            }
            localMethodMap.get(symName)!.push(symId);
          }
        }
      } else if (captureName === "qualified_func_decl") {
        const fullName = capture.node.text.trim();
        const parts = fullName.split("::");
        const methodName = parts.pop() || fullName;
        const className = parts.join("::");
        if (methodName) localDefinitions.add(methodName);
        if (className) localDefinitions.add(className);

        const scopePrefix = className ? className + "." : "";
        const symId = `${filePath}::${scopePrefix}${methodName}`;
        if (!localMethodMap.has(methodName)) {
          localMethodMap.set(methodName, []);
        }
        localMethodMap.get(methodName)!.push(symId);
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
        captureName === "struct_decl" ||
        captureName === "func_decl"
      ) {
        const symName = node.text.trim();
        if (!symName) continue;

        const scopePrefix = getEnclosingScopePath(node.parent?.parent?.parent);
        const symId = scopePrefix ? `${filePath}::${scopePrefix}.${symName}` : `${filePath}::${symName}`;
        const parentId = scopePrefix ? `${filePath}::${scopePrefix}` : filePath;

        let nodeType: NodeType = "function";
        if (captureName === "class_decl") nodeType = "class";
        else if (captureName === "struct_decl") nodeType = "struct";

        let decl = node.parent || node;
        if (decl.type === "function_declarator" && decl.parent && decl.parent.type === "function_definition") {
          decl = decl.parent;
        }

        const doc = extractCppComment(decl);

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

      else if (captureName === "qualified_func_decl") {
        const fullName = node.text.trim();
        if (!fullName) continue;

        const parts = fullName.split("::");
        const methodName = parts.pop() || fullName;
        const className = parts.join("::");
        if (!methodName) continue;

        const scopePrefix = className ? className + "." : "";
        const symId = `${filePath}::${scopePrefix}${methodName}`;
        const parentId = filePath;

        let decl = node.parent || node;
        if (decl.type === "function_declarator" && decl.parent && decl.parent.type === "function_definition") {
          decl = decl.parent;
        }

        const doc = extractCppComment(decl);

        const nodeAttrs: NodeData = {
          type: "function",
          name: methodName,
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

      else if (captureName === "include_path") {
        const includeText = node.text.trim();
        if (includeText === "" || includeText === '""' || includeText === "<>") continue;

        const resolvedPath = resolveCppInclude(includeText, filePath);
        if (!resolvedPath && isStdlibInclude(includeText)) continue;
        const cleanPath = includeText.replace(/^[<"]|[>"]$/g, "");
        const importNodeId = resolvedPath || `import::${cleanPath}`;
        if (importNodeId === "import::" || importNodeId.trim() === "") continue;

        if (!graph.hasNode(importNodeId)) {
          const nearestDescriptor = findNearestCppDescriptor(path.dirname(filePath));
          graph.addNode(importNodeId, {
            type: "file",
            name: resolvedPath ? path.basename(resolvedPath) : cleanPath,
            file: resolvedPath || nearestDescriptor || filePath,
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
        if (!calledName || CPP_BUILT_INS.has(calledName)) continue;

        const callerScope = getEnclosingScopePath(node.parent);
        const callerId = callerScope ? `${filePath}::${callerScope}` : filePath;
        const targets: { id: string; confidence: "EXTRACTED" | "INFERRED" | "AMBIGUOUS" }[] = [];

        if (localDefinitions.has(calledName)) {
          const localMatches = localMethodMap.get(calledName) || [];
          if (localMatches.length === 1 && localMatches[0]) {
            targets.push({
              id: localMatches[0],
              confidence: "EXTRACTED"
            });
          } else if (localMatches.length > 1) {
            const callerScope = getEnclosingScopePath(node.parent);
            let bestMatch = localMatches[0]!;
            let maxCommon = -1;
            for (const matchId of localMatches) {
              const matchScope = matchId.split("::")[1] || "";
              let common = 0;
              const matchParts = matchScope.split(".");
              const callerParts = callerScope.split(".");
              for (let i = 0; i < Math.min(matchParts.length, callerParts.length); i++) {
                if (matchParts[i] === callerParts[i]) common++;
                else break;
              }
              if (common > maxCommon) {
                maxCommon = common;
                bestMatch = matchId;
              }
            }
            targets.push({
              id: bestMatch,
              confidence: "EXTRACTED"
            });
          } else {
            const scopePrefix = getEnclosingScopePath(node.parent?.parent?.parent);
            targets.push({
              id: scopePrefix ? `${filePath}::${scopePrefix}.${calledName}` : `${filePath}::${calledName}`,
              confidence: "EXTRACTED"
            });
          }
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

      else if (captureName === "method_call") {
        const methodName = node.text.trim();
        if (!methodName || CPP_BUILT_INS.has(methodName)) continue;

        const callerScope = getEnclosingScopePath(node.parent);
        const callerId = callerScope ? `${filePath}::${callerScope}` : filePath;
        const targets: { id: string; confidence: "EXTRACTED" | "INFERRED" | "AMBIGUOUS" }[] = [];

        // Fuzzy match on locally defined class methods
        const localMatches = localMethodMap.get(methodName) || [];
        if (localMatches.length === 1 && localMatches[0]) {
          targets.push({
            id: localMatches[0],
            confidence: "EXTRACTED"
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
              name: methodName,
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
        if (node.parent && ["class_specifier", "struct_specifier", "base_class_specifier"].includes(node.parent.type)) {
          continue;
        }

        const referencedTypeName = node.text.trim();
        if (!referencedTypeName || CPP_BUILT_INS.has(referencedTypeName)) continue;

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
            type: "class",
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
