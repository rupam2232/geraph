import Parser from "web-tree-sitter";
type Language = Parser.Language;
type Node = Parser.SyntaxNode;
import fs from "fs";
import path from "path";
import type { MultiDirectedGraph } from "graphology";
import { NodeData, EdgeData, NodeType } from "../core/graph.js";

// Rust standard library crates — skip entirely, just like TS skips Node core modules
const RUST_STDLIB_CRATES = new Set([
  "std", "core", "alloc", "proc_macro", "test",
  // Common std sub-crates people import directly
  "collections", "env", "fmt", "fs", "io", "iter", "mem", "net", "num", "ops", "os",
  "path", "process", "ptr", "rc", "result", "slice", "str", "string", "sync", "thread",
  "time", "vec", "any", "borrow", "boxed", "cell", "clone", "cmp", "convert",
  "default", "error", "ffi", "future", "hash", "marker", "option", "panic", "pin",
  "prelude", "task"
]);

const RUST_BUILT_INS = new Set([
  // Prelude types, structs, traits, macros
  "Option", "Result", "Some", "None", "Ok", "Err", "Vec", "String", "Box", "Rc", "Arc", "Cell", "RefCell",
  "Cow", "BTreeMap", "BTreeSet", "HashMap", "HashSet", "Default", "Clone", "Copy", "Send", "Sync", "Fn", "FnMut",
  "FnOnce", "Drop", "AsRef", "AsMut", "Into", "From", "ToString", "Iterator", "IntoIterator",
  "DoubleEndedIterator", "ExactSizeIterator", "Display", "Debug", "Eq", "PartialEq", "Ord", "PartialOrd",
  "Hash", "Sized", "Unpin", "Add", "Sub", "Mul", "Div", "Rem", "Neg", "Not", "BitAnd", "BitOr", "BitXor",
  "Shl", "Shr", "Index", "IndexMut", "Deref", "DerefMut",
  // Standard lowercase built-in methods — these are instance methods that never define graph nodes
  "to_string", "clone", "as_str", "len", "is_empty", "push", "insert", "remove", "unwrap", "expect", "map",
  "and_then", "unwrap_or", "unwrap_or_else", "iter", "iter_mut", "into_iter", "collect", "contains",
  "get", "set", "as_ref", "as_mut", "into", "from", "try_from", "try_into",
  "ok", "err", "is_ok", "is_err", "is_some", "is_none",
  "to_owned", "to_vec", "as_slice", "as_bytes", "chars", "bytes", "lines", "split", "trim",
  "starts_with", "ends_with", "contains", "replace", "find", "rfind",
  "push_str", "pop", "clear", "extend", "drain", "retain", "sort", "sort_by", "reverse",
  "filter", "filter_map", "flat_map", "fold", "for_each", "any", "all", "count",
  "enumerate", "zip", "take", "skip", "chain", "peekable", "fuse",
  "read", "write", "flush", "seek", "read_to_string", "write_all",
  "lock", "try_lock", "join", "spawn",
  "with_capacity", "capacity", "reserve", "shrink_to_fit",
  "entry", "or_insert", "or_insert_with", "and_modify", "key", "keys", "values",
  "min", "max", "clamp", "abs", "pow", "sqrt",
  "parse", "format", "display",
  // Primitive types
  "u8", "u16", "u32", "u64", "u128", "usize", "i8", "i16", "i32", "i64", "i128", "isize", "f32", "f64", "bool", "char", "str",
  // Macros
  "println", "print", "format", "panic", "vec", "write", "writeln", "dbg", "todo", "unimplemented", "assert",
  "assert_eq", "assert_ne", "cfg", "env", "option_env", "file", "line", "column", "module_path", "stringify",
  "concat", "include", "include_str", "include_bytes", "eprintln", "eprint",
  // Keywords & Namespaces
  "self", "Self", "super", "crate", "std", "core", "alloc", "new"
]);

interface RustCrateInfo {
  name: string;
  rootDir: string;
}

let rustCratesCache: RustCrateInfo[] | null = null;

function findProjectRustCrates(workspaceRoot: string): RustCrateInfo[] {
  if (rustCratesCache) return rustCratesCache;
  const crates: RustCrateInfo[] = [];

  const scanDir = (dir: string, depth: number) => {
    if (depth > 4) return;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      const hasToml = entries.find(e => e.isFile() && e.name === "Cargo.toml");
      if (hasToml) {
        const tomlPath = path.join(dir, "Cargo.toml");
        const content = fs.readFileSync(tomlPath, "utf-8");
        const match = content.match(/^\s*\[package\][^]*?name\s*=\s*"([^"]+)"/m) || content.match(/^\s*\[package\][^]*?name\s*=\s*([^\s]+)/m);
        if (match && match[1]) {
          crates.push({ name: match[1].replace(/"/g, "").trim(), rootDir: dir });
        }
      }
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules" && entry.name !== "target") {
          scanDir(path.join(dir, entry.name), depth + 1);
        }
      }
    } catch {
      // ignore
    }
  };

  scanDir(workspaceRoot, 0);
  rustCratesCache = crates;
  return crates;
}

function findNearestRustDescriptor(dir: string): string {
  let current = dir;
  while (true) {
    const candidate = path.join(current, "Cargo.toml");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return "";
}

function resolveRustImport(usePathText: string, sourceFilePath: string): string | null {
  const sourceDir = path.dirname(sourceFilePath);
  const parts = usePathText.split("::");
  const firstPart = parts[0] || "";

  if (firstPart === "crate") {
    let current = sourceDir;
    let crateRoot = sourceDir;
    while (current) {
      if (fs.existsSync(path.join(current, "Cargo.toml")) || fs.existsSync(path.join(current, "src", "main.rs")) || fs.existsSync(path.join(current, "src", "lib.rs"))) {
        crateRoot = fs.existsSync(path.join(current, "src")) ? path.join(current, "src") : current;
        break;
      }
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }

    const relativeParts = parts.slice(1);
    const candidates = [
      path.join(crateRoot, ...relativeParts) + ".rs",
      path.join(crateRoot, ...relativeParts, "mod.rs")
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return candidate;
    }
  }

  const localModuleFile = path.join(sourceDir, firstPart) + ".rs";
  if (fs.existsSync(localModuleFile) && path.resolve(localModuleFile) !== path.resolve(sourceFilePath)) {
    return localModuleFile;
  }
  const localModFile = path.join(sourceDir, firstPart, "mod.rs");
  if (fs.existsSync(localModFile)) {
    return localModFile;
  }

  const workspaceRoot = process.cwd();
  const crates = findProjectRustCrates(workspaceRoot);
  const matchingCrate = crates.find(c => c.name === firstPart);
  if (matchingCrate) {
    const relativeParts = parts.slice(1);
    const candidates = [
      path.join(matchingCrate.rootDir, "src", ...relativeParts) + ".rs",
      path.join(matchingCrate.rootDir, "src", ...relativeParts, "mod.rs"),
      path.join(matchingCrate.rootDir, ...relativeParts) + ".rs",
      path.join(matchingCrate.rootDir, ...relativeParts, "mod.rs")
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return candidate;
    }
  }

  if (firstPart === "self" || firstPart === "super") {
    const relativeParts = firstPart === "super" ? ["..", ...parts.slice(1)] : parts.slice(1);
    const candidates = [
      path.resolve(sourceDir, ...relativeParts) + ".rs",
      path.resolve(sourceDir, ...relativeParts, "mod.rs")
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return candidate;
    }
  }

  return null;
}

function isRustStdlib(usePath: string): boolean {
  const firstCrate = usePath.split("::")[0] || usePath;
  return RUST_STDLIB_CRATES.has(firstCrate);
}

function extractRustDoc(node: Node): string | undefined {
  const comments: string[] = [];
  let prev = node.previousSibling;
  while (prev && (prev.type === "attribute_item" || prev.type === "inner_attribute_item")) {
    prev = prev.previousSibling;
  }
  while (prev && prev.type === "line_comment" && (prev.text.startsWith("///") || prev.text.startsWith("//!"))) {
    comments.unshift(prev.text.replace(/^\/\/\/|^\/\/!/g, "").trim());
    prev = prev.previousSibling;
  }
  return comments.length > 0 ? comments.join("\n") : undefined;
}

const getRustImplType = (node: Node): string => {
  if (node.type !== "impl_item") return "";
  const typeNode = node.childForFieldName("type");
  if (!typeNode) return "";
  
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
  findType(typeNode);
  return typeName;
};

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

export function parseRust(
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
  const importMap = new Map<string, string>(); // symName -> usePath
  const localMethodMap = new Map<string, string[]>();

  const queryString = `
    (use_declaration argument: (_) @use_source)

    (struct_item name: (type_identifier) @struct_decl)
    (enum_item name: (type_identifier) @enum_decl)
    (trait_item name: (type_identifier) @trait_decl)
    (function_item name: (identifier) @func_decl)
    (macro_definition name: (identifier) @macro_decl)

    (call_expression function: (identifier) @call_name)
    (call_expression function: (field_expression field: (field_identifier) @method_call))
    (call_expression function: (scoped_identifier name: (identifier) @scoped_call) path: (_)? @scoped_path)
    (macro_invocation macro: (identifier) @macro_name)

    (type_identifier) @type_reference
  `;

  const query = language.query(queryString);
  const matches = query.matches(tree.rootNode);

  const getEnclosingScopePath = (startNode: Node | null | undefined): string => {
    const pathParts: string[] = [];
    let current = startNode;
    while (current) {
      if (current.type === "impl_item") {
        const implType = getRustImplType(current);
        if (implType) pathParts.unshift(implType);
      } else if (
        current.type === "struct_item" ||
        current.type === "enum_item" ||
        current.type === "trait_item" ||
        current.type === "function_item"
      ) {
        const nameNode = current.childForFieldName("name");
        if (nameNode) pathParts.unshift(nameNode.text.trim());
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

      if (captureName === "use_source") {
        const usePath = node.text.trim();
        const symName = usePath.split("::").pop() || usePath;
        importMap.set(symName, usePath);
      } else if (
        captureName === "struct_decl" ||
        captureName === "enum_decl" ||
        captureName === "trait_decl" ||
        captureName === "func_decl" ||
        captureName === "macro_decl"
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
        captureName === "struct_decl" ||
        captureName === "enum_decl" ||
        captureName === "trait_decl" ||
        captureName === "func_decl" ||
        captureName === "macro_decl"
      ) {
        const symName = node.text.trim();
        if (!symName) continue;

        const scopePrefix = getEnclosingScopePath(node.parent?.parent);
        const symId = scopePrefix ? `${filePath}::${scopePrefix}.${symName}` : `${filePath}::${symName}`;
        const parentId = scopePrefix ? `${filePath}::${scopePrefix}` : filePath;

        let nodeType: NodeType = "function";
        if (captureName === "struct_decl") nodeType = "struct";
        else if (captureName === "enum_decl") nodeType = "enum";
        else if (captureName === "trait_decl") nodeType = "trait";
        else if (captureName === "macro_decl") nodeType = "macro";

        const decl = node.parent || node;
        const doc = extractRustDoc(decl);

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

      else if (captureName === "use_source") {
        const usePath = node.text.trim();
        if (usePath === "" || usePath === "*" || usePath === "self" || usePath === "super") continue;

        const resolvedPath = resolveRustImport(usePath, filePath);
        if (!resolvedPath && isRustStdlib(usePath)) continue;
        const importNodeId = resolvedPath || `import::${usePath}`;
        if (importNodeId === "import::" || importNodeId.trim() === "") continue;

        if (!graph.hasNode(importNodeId)) {
          const nearestDescriptor = findNearestRustDescriptor(path.dirname(filePath));
          graph.addNode(importNodeId, {
            type: "file",
            name: resolvedPath ? path.basename(resolvedPath) : usePath,
            file: resolvedPath || nearestDescriptor || filePath,
            startLine: 0,
            metadata: resolvedPath ? {} : { external: true }
          });
        }

        if (!graph.hasEdge(filePath, importNodeId)) {
          graph.addEdge(filePath, importNodeId, { type: "imports", confidence: "EXTRACTED" });
        }
      }

      else if (captureName === "call_name" || captureName === "macro_name") {
        const calledName = node.text.trim();
        if (!calledName || RUST_BUILT_INS.has(calledName)) continue;

        const callerScope = getEnclosingScopePath(node.parent);
        const callerId = callerScope ? `${filePath}::${callerScope}` : filePath;
        const targets: { id: string; confidence: "EXTRACTED" | "INFERRED" | "AMBIGUOUS" }[] = [];

        const importSource = importMap.get(calledName);
        if (importSource) {
          const resolvedSource = resolveRustImport(importSource, filePath);
          const targetBase = resolvedSource || `import::${importSource}`;
          targets.push({
            id: `${targetBase}::${calledName}`,
            confidence: "EXTRACTED"
          });
        } else if (localDefinitions.has(calledName)) {
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
            const scopePrefix = getEnclosingScopePath(node.parent?.parent);
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
              type: (captureName === "macro_name" ? "macro" : "function"),
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
        if (!methodName || RUST_BUILT_INS.has(methodName)) continue;

        let objectName = "";
        if (node.parent && node.parent.type === "field_expression") {
          const valueNode = node.parent.childForFieldName("value");
          if (valueNode) objectName = valueNode.text.trim();
        }

        if (objectName && RUST_STDLIB_CRATES.has(objectName)) continue;

        const callerScope = getEnclosingScopePath(node.parent);
        const callerId = callerScope ? `${filePath}::${callerScope}` : filePath;
        const targets: { id: string; confidence: "EXTRACTED" | "INFERRED" | "AMBIGUOUS" }[] = [];

        const importSource = importMap.get(objectName);
        if (importSource) {
          const resolvedSource = resolveRustImport(importSource, filePath);
          if (!resolvedSource && isRustStdlib(importSource)) continue;
          const targetBase = resolvedSource || `import::${importSource}`;
          targets.push({
            id: `${targetBase}::${methodName}`,
            confidence: "EXTRACTED"
          });
        } else {
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

      else if (captureName === "scoped_call") {
        const calledName = node.text.trim();
        if (!calledName || RUST_BUILT_INS.has(calledName)) continue;

        let pathPrefix = "";
        if (node.parent && node.parent.type === "scoped_identifier") {
          const pathNode = node.parent.childForFieldName("path");
          if (pathNode) pathPrefix = pathNode.text.trim();
        }

        if (pathPrefix && RUST_STDLIB_CRATES.has(pathPrefix)) continue;

        const callerScope = getEnclosingScopePath(node.parent);
        const callerId = callerScope ? `${filePath}::${callerScope}` : filePath;
        const targets: { id: string; confidence: "EXTRACTED" | "INFERRED" | "AMBIGUOUS" }[] = [];

        const importSource = importMap.get(pathPrefix);
        if (importSource) {
          const resolvedSource = resolveRustImport(importSource, filePath);
          if (!resolvedSource && isRustStdlib(importSource)) continue;
          const targetBase = resolvedSource || `import::${importSource}`;
          targets.push({
            id: `${targetBase}::${calledName}`,
            confidence: "EXTRACTED"
          });
        } else if (localDefinitions.has(pathPrefix)) {
          targets.push({
            id: `${filePath}::${pathPrefix}.${calledName}`,
            confidence: "EXTRACTED"
          });
        } else {
          // Fuzzy match on local method name or fallback to unresolved
          const localMatches = localMethodMap.get(calledName) || [];
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
              id: `unresolved::${pathPrefix ? pathPrefix + "::" : ""}${calledName}`,
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
              name: pathPrefix ? `${pathPrefix}::${calledName}` : calledName,
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
        if (node.parent && ["struct_item", "enum_item", "trait_item", "impl_item", "type_bound", "bounded_type"].includes(node.parent.type)) {
          continue;
        }

        const referencedTypeName = node.text.trim();
        if (!referencedTypeName || RUST_BUILT_INS.has(referencedTypeName)) continue;

        const callerScope = getEnclosingScopePath(node.parent);
        const callerId = callerScope ? `${filePath}::${callerScope}` : filePath;
        if (!graph.hasNode(callerId)) continue;
        
        let targetId: string;
        const importSource = importMap.get(referencedTypeName);
        if (localDefinitions.has(referencedTypeName)) {
          targetId = `${filePath}::${referencedTypeName}`;
        } else if (importSource) {
          const resolvedSource = resolveRustImport(importSource, filePath);
          if (!resolvedSource && isRustStdlib(importSource)) continue;
          targetId = `${resolvedSource || `import::${importSource}`}::${referencedTypeName}`;
        } else {
          targetId = `unresolved::${referencedTypeName}`;
        }

        const isUnresolved = !localDefinitions.has(referencedTypeName) && !importSource;

        if (!graph.hasNode(targetId)) {
          graph.addNode(targetId, {
            type: "struct",
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
