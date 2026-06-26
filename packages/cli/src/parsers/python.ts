import Parser from "web-tree-sitter";
type Language = Parser.Language;
type Node = Parser.SyntaxNode;
import fs from "fs";
import path from "path";
import type { MultiDirectedGraph } from "graphology";
import { NodeData, EdgeData } from "../core/graph.js";

// Python standard library modules — skip entirely, just like TS skips Node core modules
const PYTHON_STDLIB_MODULES = new Set([
  "abc", "aifc", "argparse", "array", "ast", "asynchat", "asyncio", "asyncore", "atexit",
  "base64", "bdb", "binascii", "binhex", "bisect", "builtins", "bz2",
  "calendar", "cgi", "cgitb", "chunk", "cmath", "cmd", "code", "codecs", "codeop",
  "collections", "colorsys", "compileall", "concurrent", "configparser", "contextlib",
  "contextvars", "copy", "copyreg", "cProfile", "crypt", "csv", "ctypes", "curses",
  "dataclasses", "datetime", "dbm", "decimal", "difflib", "dis", "distutils", "doctest",
  "email", "encodings", "enum", "errno",
  "faulthandler", "fcntl", "filecmp", "fileinput", "fnmatch", "fractions", "ftplib", "functools",
  "gc", "getopt", "getpass", "gettext", "glob", "grp", "gzip",
  "hashlib", "heapq", "hmac", "html", "http",
  "idlelib", "imaplib", "imghdr", "imp", "importlib", "inspect", "io", "ipaddress", "itertools",
  "json",
  "keyword",
  "lib2to3", "linecache", "locale", "logging", "lzma",
  "mailbox", "mailcap", "marshal", "math", "mimetypes", "mmap", "modulefinder", "multiprocessing",
  "netrc", "nis", "nntplib", "numbers",
  "operator", "optparse", "os", "ossaudiodev",
  "pathlib", "pdb", "pickle", "pickletools", "pipes", "pkgutil", "platform", "plistlib",
  "poplib", "posix", "posixpath", "pprint", "profile", "pstats", "pty", "pwd", "py_compile",
  "pyclbr", "pydoc",
  "queue", "quopri",
  "random", "re", "readline", "reprlib", "resource", "rlcompleter", "runpy",
  "sched", "secrets", "select", "selectors", "shelve", "shlex", "shutil", "signal", "site",
  "smtpd", "smtplib", "sndhdr", "socket", "socketserver", "sqlite3", "ssl", "stat",
  "statistics", "string", "stringprep", "struct", "subprocess", "sunau", "symtable", "sys",
  "sysconfig", "syslog",
  "tabnanny", "tarfile", "telnetlib", "tempfile", "termios", "test", "textwrap", "threading",
  "time", "timeit", "tkinter", "token", "tokenize", "tomllib", "trace", "traceback",
  "tracemalloc", "tty", "turtle", "turtledemo", "types", "typing",
  "unicodedata", "unittest", "urllib", "uu", "uuid",
  "venv",
  "warnings", "wave", "weakref", "webbrowser", "winreg", "winsound", "wsgiref",
  "xdrlib", "xml", "xmlrpc",
  "zipapp", "zipfile", "zipimport", "zlib",
  // Common third-party but universally recognized
  "_thread", "__future__", "__main__"
]);

const PYTHON_BUILT_INS = new Set([
  // Built-in functions & primitives
  "print", "len", "range", "dict", "list", "set", "tuple", "open", "sum", "max", "min", "abs", "str", "int", "float",
  "enumerate", "zip", "any", "all", "map", "filter", "sorted", "repr", "isinstance", "type", "self", "cls", "__init__",
  "bool", "bytes", "chr", "ord", "dir", "id", "hash", "input", "pow", "round", "globals", "locals", "vars", "super",
  "property", "staticmethod", "classmethod", "next", "iter", "getattr", "setattr", "hasattr", "delattr", "callable",
  "eval", "exec", "format", "slice", "reversed", "complex", "frozenset", "memoryview", "bytearray", "object",
  "breakpoint", "compile", "help", "ascii", "bin", "hex", "oct", "issubclass",
  // Magic methods
  "__str__", "__repr__", "__len__", "__getitem__", "__setitem__", "__delitem__", "__iter__", "__next__", "__call__",
  "__enter__", "__exit__", "__new__", "__del__", "__getattr__", "__getattribute__", "__setattr__", "__delattr__",
  "__dir__", "__eq__", "__ne__", "__lt__", "__le__", "__gt__", "__ge__", "__add__", "__sub__", "__mul__",
  "__truediv__", "__floordiv__", "__mod__", "__pow__", "__contains__", "__hash__", "__bool__", "__format__",
  "__init_subclass__", "__class_getitem__",
  // Common instance methods that should never be graph nodes
  "append", "extend", "insert", "remove", "pop", "clear", "index", "count", "sort", "reverse", "copy",
  "update", "get", "keys", "values", "items", "setdefault", "join", "split", "strip", "lstrip", "rstrip",
  "startswith", "endswith", "replace", "find", "rfind", "upper", "lower", "title", "capitalize",
  "encode", "decode", "format_map", "center", "ljust", "rjust", "zfill", "expandtabs", "isdigit", "isalpha",
  "isalnum", "isspace", "isupper", "islower", "istitle",
  "read", "write", "close", "flush", "seek", "tell", "readline", "readlines", "writelines",
  // Exceptions
  "Exception", "ValueError", "TypeError", "KeyError", "IndexError", "AttributeError", "ImportError", "RuntimeError",
  "SystemExit", "StopIteration", "KeyboardInterrupt", "AssertionError", "FileNotFoundError", "IOError",
  "OSError", "PermissionError", "NotImplementedError", "ZeroDivisionError", "OverflowError", "RecursionError",
  // Typing module types
  "List", "Dict", "Tuple", "Set", "Optional", "Union", "Any", "Callable", "Sequence", "Mapping",
  "Iterator", "Generator", "Coroutine", "Awaitable", "AsyncIterator", "AsyncGenerator",
  "ClassVar", "Final", "Literal", "TypeVar", "Generic", "Protocol", "TypedDict", "NamedTuple"
]);

function findNearestPythonDescriptor(dir: string): string {
  let current = dir;
  while (true) {
    for (const name of ["requirements.txt", "pyproject.toml", "setup.py", "Pipfile"]) {
      const candidate = path.join(current, name);
      if (fs.existsSync(candidate)) return candidate;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return "";
}

function resolvePythonImport(importName: string, sourceFilePath: string): string | null {
  const parts = importName.split(".");
  const sourceDir = path.dirname(sourceFilePath);

  // Try relative path resolutions first
  const candidates = [
    path.resolve(sourceDir, ...parts) + ".py",
    path.resolve(sourceDir, ...parts, "__init__.py")
  ];

  // Try workspace absolute resolution
  const workspaceRoot = process.cwd();
  candidates.push(
    path.resolve(workspaceRoot, ...parts) + ".py",
    path.resolve(workspaceRoot, ...parts, "__init__.py")
  );

  // Also resolve relative to parent directories containing python descriptors for monorepos
  let current = sourceDir;
  while (current) {
    for (const desc of ["requirements.txt", "pyproject.toml", "setup.py", "Pipfile"]) {
      if (fs.existsSync(path.join(current, desc))) {
        candidates.push(
          path.resolve(current, ...parts) + ".py",
          path.resolve(current, ...parts, "__init__.py")
        );
      }
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      if (path.resolve(candidate) === path.resolve(sourceFilePath)) continue;
      return candidate;
    }
  }
  return null;
}

function extractDocstring(node: Node): string | undefined {
  const body = node.childForFieldName("body");
  if (!body) return undefined;

  const block = body.type === "block" ? body : null;
  if (!block || block.childCount === 0) return undefined;

  const firstExpr = block.child(0);
  if (firstExpr && firstExpr.type === "expression_statement") {
    const stringNode = firstExpr.child(0);
    if (stringNode && stringNode.type === "string") {
      return stringNode.text.replace(/^"""|"""$/g, "").replace(/^'''|'''$/g, "").trim();
    }
  }
  return undefined;
}

function isLocalDeclaration(startNode: Parser.SyntaxNode | null | undefined, name: string): boolean {
  let current = startNode;
  const checkPattern = (patternNode: Parser.SyntaxNode): boolean => {
    if (patternNode.type === "identifier") {
      return patternNode.text.trim() === name;
    }
    if (patternNode.type === "attribute") {
      return false;
    }
    for (let i = 0; i < patternNode.namedChildCount; i++) {
      const child = patternNode.namedChild(i);
      if (child && checkPattern(child)) return true;
    }
    return false;
  };

  while (current) {
    if (
      current.type === "function_definition" ||
      current.type === "lambda"
    ) {
      const paramsNode = current.childForFieldName("parameters") || current.namedChild(0);
      if (paramsNode && checkPattern(paramsNode)) {
        return true;
      }
    }

    if (current.type === "for_statement") {
      const leftNode = current.childForFieldName("left") || current.namedChild(0);
      if (leftNode && checkPattern(leftNode)) {
        return true;
      }
    }

    if (current.type === "with_statement") {
      const findAsPatternTarget = (n: Parser.SyntaxNode): boolean => {
        if (n.type === "as_pattern_target") {
          return checkPattern(n);
        }
        for (let i = 0; i < n.namedChildCount; i++) {
          const child = n.namedChild(i);
          if (child && findAsPatternTarget(child)) return true;
        }
        return false;
      };
      if (findAsPatternTarget(current)) {
        return true;
      }
    }

    if (current.type === "block") {
      for (let i = 0; i < current.namedChildCount; i++) {
        const statement = current.namedChild(i);
        if (!statement) continue;

        let assignNode: Parser.SyntaxNode | null = null;
        if (statement.type === "assignment") {
          assignNode = statement;
        } else if (statement.type === "expression_statement") {
          const firstChild = statement.namedChild(0);
          if (firstChild && firstChild.type === "assignment") {
            assignNode = firstChild;
          }
        }

        if (assignNode) {
          const leftNode = assignNode.childForFieldName("left") || assignNode.namedChild(0);
          if (leftNode && checkPattern(leftNode)) {
            if (statement.startIndex <= (startNode?.startIndex ?? 0)) {
              return true;
            }
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

export function parsePython(
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
  const importMap = new Map<string, string>(); // importedSymbol -> importSource
  const importOriginalNameMap = new Map<string, string>(); // localName -> originalName
  const localMethodMap = new Map<string, string[]>();

  const getRootIdentifier = (node: Node | null): string => {
    if (!node) return "";
    if (node.type === "identifier") return node.text.trim();
    if (node.type === "attribute") {
      return getRootIdentifier(node.childForFieldName("object"));
    }
    if (node.type === "call") {
      return getRootIdentifier(node.childForFieldName("function"));
    }
    if (node.type === "await" || node.type === "parenthesized_expression") {
      const valueNode = node.namedChild(0);
      return getRootIdentifier(valueNode);
    }
    return "";
  };

  const queryString = `
    (import_statement [
      (dotted_name)
      (aliased_import)
    ] @import_direct)

    (import_from_statement 
      module_name: [
        (dotted_name)
        (relative_import)
      ] @import_from
    )

    (import_from_statement 
      module_name: [
        (dotted_name)
        (relative_import)
      ]
      name: [
        (dotted_name)
        (aliased_import)
      ] @import_symbol
    )

    (class_definition name: (identifier) @class_decl)
    (function_definition name: (identifier) @func_decl)

    (call function: (identifier) @call_name)
    (call function: (attribute attribute: (identifier) @call_attr_name) )
    (call function: (attribute object: (identifier) @call_attr_object attribute: (identifier) @call_attr_name))

    (type (identifier) @type_reference)
  `;

  const query = language.query(queryString);
  const matches = query.matches(tree.rootNode);

  const getEnclosingScopePath = (startNode: Node | null | undefined): string => {
    const pathParts: string[] = [];
    let current = startNode;
    while (current) {
      if (current.type === "class_definition" || current.type === "function_definition") {
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
    let activeImportSource = "";
    for (const capture of match.captures) {
      const node = capture.node;
      const captureName = capture.name;

      if (captureName === "import_direct") {
        if (node.type === "dotted_name") {
          const importPath = node.text.trim();
          if (importPath && importPath !== "") {
            importMap.set(importPath, importPath);
          }
        } else if (node.type === "aliased_import") {
          const originalNode = node.namedChild(0);
          const aliasNode = node.namedChild(1);
          if (originalNode && aliasNode) {
            const originalPath = originalNode.text.trim();
            const alias = aliasNode.text.trim();
            importMap.set(alias, originalPath);
            const originalName = originalPath.split(".").pop() || originalPath;
            if (originalName && originalName !== alias) {
              importOriginalNameMap.set(alias, originalName);
            }
          }
        }
      } else if (captureName === "import_from") {
        activeImportSource = node.text.trim();
      } else if (captureName === "import_symbol" && activeImportSource) {
        if (node.type === "dotted_name") {
          const symName = node.text.trim();
          if (symName && symName !== "") {
            importMap.set(symName, activeImportSource);
          }
        } else if (node.type === "aliased_import") {
          const originalNode = node.namedChild(0);
          const aliasNode = node.namedChild(1);
          if (originalNode && aliasNode) {
            const originalName = originalNode.text.trim();
            const alias = aliasNode.text.trim();
            importMap.set(alias, activeImportSource);
            if (originalName && originalName !== alias) {
              importOriginalNameMap.set(alias, originalName);
            }
          }
        }
      } else if (captureName === "class_decl" || captureName === "func_decl") {
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

      if (captureName === "class_decl" || captureName === "func_decl") {
        const symName = node.text.trim();
        if (!symName) continue;

        const scopePrefix = getEnclosingScopePath(node.parent?.parent);
        const symId = scopePrefix ? `${filePath}::${scopePrefix}.${symName}` : `${filePath}::${symName}`;
        const parentId = scopePrefix ? `${filePath}::${scopePrefix}` : filePath;

        const isClass = captureName === "class_decl";
        const decl = node.parent || node;
        const doc = extractDocstring(decl);

        const nodeAttrs: NodeData = {
          type: isClass ? "class" : "function",
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

      else if (captureName === "import_direct" || captureName === "import_from") {
        let importPath = node.text.trim();
        if (node.type === "aliased_import") {
          const originalNode = node.namedChild(0);
          if (originalNode) {
            importPath = originalNode.text.trim();
          }
        }
        if (importPath === "" || importPath === "." || importPath === "*") continue;

        const resolvedPath = resolvePythonImport(importPath, filePath);
        const rootModule = importPath.split(".")[0] || importPath;
        if (!resolvedPath && PYTHON_STDLIB_MODULES.has(rootModule)) continue;
        const importNodeId = resolvedPath || `import::${importPath}`;
        if (importNodeId === "import::" || importNodeId.trim() === "") continue;

        if (importNodeId === filePath) continue;

        if (!graph.hasNode(importNodeId)) {
          const nearestDescriptor = findNearestPythonDescriptor(path.dirname(filePath));
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

      else if (captureName === "call_name") {
        const calledName = node.text.trim();
        if (!calledName || PYTHON_BUILT_INS.has(calledName)) continue;
        if (isLocalDeclaration(node, calledName)) continue;

        const importSource = importMap.get(calledName);

        if (importSource) {
          const resolvedImport = resolvePythonImport(importSource, filePath);
          const importRoot = importSource.split(".")[0] || importSource;
          if (!resolvedImport && PYTHON_STDLIB_MODULES.has(importRoot)) continue;
        }

        const callerScope = getEnclosingScopePath(node.parent);
        const callerId = callerScope ? `${filePath}::${callerScope}` : filePath;
        const targets: { id: string; confidence: "EXTRACTED" | "INFERRED" | "AMBIGUOUS" }[] = [];

        const resolvedImport = importSource ? resolvePythonImport(importSource, filePath) : null;

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
            const scopePrefix = getEnclosingScopePath(node.parent?.parent);
            targets.push({
              id: scopePrefix ? `${filePath}::${scopePrefix}.${calledName}` : `${filePath}::${calledName}`,
              confidence: "EXTRACTED"
            });
          }
        } else if (resolvedImport) {
          const originalName = importOriginalNameMap.get(calledName) || calledName;
          targets.push({
            id: `${resolvedImport}::${originalName}`,
            confidence: "EXTRACTED"
          });
        } else if (importSource) {
          const originalName = importOriginalNameMap.get(calledName) || calledName;
          targets.push({
            id: `import::${importSource}::${originalName}`,
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
                callerLine: isUnresolved ? callLine : undefined,
                doc: isUnresolved ? "Called/Instantiated but not defined in any scanned file." : undefined
              }
            });
          }

          if (callerId === target.id) continue;
          if (!graph.hasEdge(callerId, target.id)) {
            graph.addEdge(callerId, target.id, { type: "calls", confidence: target.confidence });
          }
        }

        if (importSource && !resolvedImport) {
          const importNodeId = `import::${importSource}`;
          if (importNodeId !== "import::" && !PYTHON_STDLIB_MODULES.has(importSource.split(".")[0] || importSource)) {
            const nearestDescriptor = findNearestPythonDescriptor(path.dirname(filePath));
            if (!graph.hasNode(importNodeId)) {
              graph.addNode(importNodeId, {
                type: "file",
                name: importSource,
                file: nearestDescriptor || filePath,
                startLine: 0,
                metadata: { external: true }
              });
            }
            for (const target of targets) {
              if (!graph.hasEdge(importNodeId, target.id)) {
                graph.addEdge(importNodeId, target.id, { type: "defines", confidence: "EXTRACTED" });
              }
            }
          }
        }
      }

      else if (captureName === "call_attr_name") {
        const methodName = node.text.trim();
        if (!methodName || PYTHON_BUILT_INS.has(methodName)) continue;

        let objectName = "";
        if (node.parent?.type === "attribute") {
          const objectNode = node.parent.childForFieldName("object");
          if (objectNode) {
            objectName = getRootIdentifier(objectNode);
          }
        }

        const resolvedObject = resolvePythonImport(objectName, filePath);
        if (objectName && !resolvedObject && PYTHON_STDLIB_MODULES.has(objectName)) {
          continue;
        }
        if (isLocalDeclaration(node, objectName ? `${objectName}.${methodName}` : methodName)) continue;

        const importSource = importMap.get(objectName);
        if (importSource) {
          const resolvedSource = resolvePythonImport(importSource, filePath);
          const importRoot = importSource.split(".")[0] || importSource;
          if (!resolvedSource && PYTHON_STDLIB_MODULES.has(importRoot)) continue;
        }

        const callerScope = getEnclosingScopePath(node.parent);
        const callerId = callerScope ? `${filePath}::${callerScope}` : filePath;
        const targets: { id: string; confidence: "EXTRACTED" | "INFERRED" | "AMBIGUOUS" }[] = [];

        if (objectName) {
          if (importSource) {
            const resolvedSource = resolvePythonImport(importSource, filePath);
            const targetBase = resolvedSource || `import::${importSource}`;
            targets.push({
              id: `${targetBase}::${methodName}`,
              confidence: "EXTRACTED"
            });
          } else if (localDefinitions.has(objectName)) {
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
                id: `${filePath}::${objectName}.${methodName}`,
                confidence: "EXTRACTED"
              });
            }
          } else {
            // objectName is a local instance variable (e.g. calc.add())
            // Fuzzy match the method name against localMethodMap!
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
            }
          }
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

      else if (captureName === "type_reference") {
        const referencedTypeName = node.text.trim();
        if (!referencedTypeName || PYTHON_BUILT_INS.has(referencedTypeName)) continue;
        if (isLocalDeclaration(node, referencedTypeName)) continue;

        const callerScope = getEnclosingScopePath(node.parent);
        const callerId = callerScope ? `${filePath}::${callerScope}` : filePath;
        if (!graph.hasNode(callerId)) continue;
        
        let targetId: string;
        const importSource = importMap.get(referencedTypeName);
        if (localDefinitions.has(referencedTypeName)) {
          targetId = `${filePath}::${referencedTypeName}`;
        } else if (importSource) {
          const resolvedSource = resolvePythonImport(importSource, filePath);
          const importRoot = importSource.split(".")[0] || importSource;
          if (!resolvedSource && PYTHON_STDLIB_MODULES.has(importRoot)) continue;
          const originalName = importOriginalNameMap.get(referencedTypeName) || referencedTypeName;
          targetId = `${resolvedSource || `import::${importSource}`}::${originalName}`;
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
