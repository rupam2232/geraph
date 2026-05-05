import Parser, { Query } from "tree-sitter";
import tsLanguage from "tree-sitter-typescript";
import jsLanguage from "tree-sitter-javascript";
import fs from "fs";
import path from "path";
import chalk from "chalk";
import { builtinModules } from "module";
import type { MultiDirectedGraph } from "graphology";
import type { NodeData, EdgeData } from "../core/graph.js";

// Set of all Node.js core module names for O(1) lookup.
// Used to skip calls like fs.readFileSync(), path.join(), os.homedir() etc.
const NODE_CORE_MODULES = new Set(builtinModules);

// ─── True ECMAScript + Node.js intrinsics only ────────────────────────────────
// We deliberately exclude library-specific methods (chalk, ora, graphology, etc.)
// because those are user-codebase-dependent and SHOULD appear in the call graph.
// Only methods that are guaranteed to be in every JavaScript/Node.js runtime are blocked.
const BUILT_INS = new Set([
  // Array.prototype
  "map",
  "filter",
  "reduce",
  "reduceRight",
  "forEach",
  "flat",
  "flatMap",
  "find",
  "findIndex",
  "findLast",
  "findLastIndex",
  "some",
  "every",
  "sort",
  "reverse",
  "includes",
  "indexOf",
  "lastIndexOf",
  "push",
  "pop",
  "shift",
  "unshift",
  "splice",
  "slice",
  "fill",
  "copyWithin",
  "at",
  // Object
  "hasOwnProperty",
  "toString",
  "valueOf",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toLocaleString",
  // Object static
  "assign",
  "create",
  "freeze",
  "seal",
  "keys",
  "values",
  "entries",
  "getOwnPropertyNames",
  "getOwnPropertyDescriptor",
  "getPrototypeOf",
  "defineProperty",
  // Map / Set / WeakMap / WeakSet
  "has",
  "get",
  "set",
  "add",
  "delete",
  "clear",
  // String.prototype
  "split",
  "replace",
  "replaceAll",
  "match",
  "matchAll",
  "search",
  "substring",
  "substr",
  "trim",
  "trimStart",
  "trimEnd",
  "charAt",
  "charCodeAt",
  "codePointAt",
  "concat",
  "repeat",
  "normalize",
  "startsWith",
  "endsWith",
  "padStart",
  "padEnd",
  "toLowerCase",
  "toUpperCase",
  "toLocaleLowerCase",
  "toLocaleUpperCase",
  // Array / String shared
  "join",
  "indexOf",
  "lastIndexOf",
  "includes",
  "at",
  // Date.prototype (all methods)
  "getDate",
  "getDay",
  "getFullYear",
  "getHours",
  "getMilliseconds",
  "getMinutes",
  "getMonth",
  "getSeconds",
  "getTime",
  "getTimezoneOffset",
  "getUTCDate",
  "getUTCDay",
  "getUTCFullYear",
  "getUTCHours",
  "getUTCMilliseconds",
  "getUTCMinutes",
  "getUTCMonth",
  "getUTCSeconds",
  "setDate",
  "setFullYear",
  "setHours",
  "setMilliseconds",
  "setMinutes",
  "setMonth",
  "setSeconds",
  "setTime",
  "setUTCDate",
  "setUTCFullYear",
  "setUTCHours",
  "setUTCMilliseconds",
  "setUTCMinutes",
  "setUTCMonth",
  "setUTCSeconds",
  "toISOString",
  "toJSON",
  "toDateString",
  "toTimeString",
  "toUTCString",
  "toLocaleDateString",
  "toLocaleTimeString",
  // Promise
  "then",
  "catch",
  "finally",
  "resolve",
  "reject",
  "all",
  "race",
  "allSettled",
  "any",
  // Timers (Node.js + browser globals)
  "setTimeout",
  "setInterval",
  "clearTimeout",
  "clearInterval",
  "setImmediate",
  "clearImmediate",
  "queueMicrotask",
  // console (Node.js global)
  "log",
  "warn",
  "error",
  "info",
  "debug",
  "trace",
  "table",
  "group",
  "groupEnd",
  "assert",
  "dir",
  "count",
  "countReset",
  "time",
  "timeEnd",
  "timeLog",
  // JSON
  "stringify",
  "parse",
  // Math static
  "floor",
  "ceil",
  "round",
  "abs",
  "max",
  "min",
  "sqrt",
  "pow",
  "random",
  "sign",
  "trunc",
  "log",
  "log2",
  "log10",
  "exp",
  "hypot",
  "cbrt",
  "clz32",
  // Number static + prototype
  "parseInt",
  "parseFloat",
  "isNaN",
  "isFinite",
  "isInteger",
  "isSafeInteger",
  "toFixed",
  "toPrecision",
  "toExponential",
  // Function.prototype
  "call",
  "apply",
  "bind",
  // Iterator / Generator protocol
  "next",
  "return",
  "throw",
  // Node.js process
  "cwd",
  "exit",
  "chdir",
  "memoryUsage",
  "hrtime",
  "nextTick",
  "uptime",
  "cpuUsage",
  "resourceUsage",
  "send",
  "abort",
  // EventEmitter (Node.js built-in)
  "on",
  "off",
  "emit",
  "once",
  "removeListener",
  "removeAllListeners",
  "addListener",
  "listeners",
  "listenerCount",
  "eventNames",
  "prependListener",
  // Reflect / Proxy
  "construct",
  "ownKeys",
  // Symbol
  "for",
  "keyFor",
  // Intl
  "format",
  "formatToParts",
  "resolvedOptions",
  "supportedLocalesOf",
  // Array.from / Array.of / Object.fromEntries etc.
  "from",
  "of",
  "fromEntries",
  "fromCharCode",
  "fromCodePoint",
]);

/**
 * Resolves a TypeScript/ESM import path to the actual file node ID in the graph.
 * Handles the `.js` → `.ts`/`.tsx` extension remapping that TypeScript requires.
 * Returns the real node ID if found, or null if the import is external/unresolvable.
 */
function resolveImportToNode(
  importPath: string,
  sourceFilePath: string,
): string | null {
  // Only resolve relative imports — package imports are always external
  if (!importPath.startsWith(".")) return null;

  const sourceDir = path.dirname(sourceFilePath);
  const resolvedBase = path.resolve(sourceDir, importPath);

  // TypeScript emits .js imports but the real files are .ts/.tsx.
  // Build a candidate list covering all common resolution strategies.
  const candidates: string[] = [
    resolvedBase, // exact match (already .ts)
    resolvedBase.replace(/\.js$/, ".ts"), // ./scanner.js → scanner.ts
    resolvedBase.replace(/\.js$/, ".tsx"), // ./component.js → component.tsx
    resolvedBase.replace(/\.js$/, "/index.ts"), // ./utils.js → utils/index.ts
    resolvedBase.replace(/\.js$/, "/index.tsx"),
    resolvedBase + ".ts", // bare path → path.ts
    resolvedBase + ".tsx",
    resolvedBase + "/index.ts", // directory → index.ts
    resolvedBase + "/index.tsx",
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

export function parseTypeScript(
  filePath: string,
  graph: MultiDirectedGraph<NodeData, EdgeData>,
) {
  const isTs = filePath.endsWith(".ts") || filePath.endsWith(".tsx");
  const isTsx = filePath.endsWith(".tsx");

  // Robust language selection for different tree-sitter-typescript/javascript versions
  let language;
  if (isTs) {
    const tsObj = tsLanguage;
    if (isTsx) {
      language = tsObj.tsx || tsObj;
    } else {
      language = tsObj.typescript || tsObj;
    }
  } else {
    language = jsLanguage;
  }

  const parser = new Parser();
  try {
    parser.setLanguage(language);
  } catch {
    console.error(chalk.red(`\n❌ Failed to set language for ${filePath}. Check if tree-sitter bindings are correct.`));
    return;
  }

  let sourceCode: string;
  try {
    const buffer = fs.readFileSync(filePath);
    sourceCode = buffer.toString("utf8").replace(/\0/g, "");
  } catch (error) {
    if (error instanceof Error) {
      console.error(chalk.red(`⚠️ Error reading ${filePath}: ${error.message}`));
    }
    return;
  }

  let tree: Parser.Tree;
  try {
    // Use the callback API to feed chunks to the native engine.
    // This is more robust on Windows than passing one giant string.
    tree = parser.parse((index: number) => {
      if (index >= sourceCode.length) return null;
      return sourceCode.substring(index, index + 10240); // 10KB chunks
    });
  } catch {
    try {
      // Fallback: Strip non-ASCII characters and try again
      // eslint-disable-next-line no-control-regex
      const asciiOnly = sourceCode.replace(/[^\x00-\x7F]/g, " ");
      tree = parser.parse((index: number) => {
        if (index >= asciiOnly.length) return null;
        return asciiOnly.substring(index, index + 10240);
      });
    } catch {
      console.error(chalk.red(`⚠️ Warning: Could not parse ${filePath}. Skipping...`));
      return;
    }
  }

  const baseQueryString = `
    (import_statement source: (string) @import_source)
    (call_expression
      function: (identifier) @req_fn
      arguments: (arguments (string) @require_source)
      (#eq? @req_fn "require")
    )
    
    ; Capture class names (abstract only in TS)
    ${isTs ? "[(class_declaration) (abstract_class_declaration)] @class_decl" : "(class_declaration) @class_decl"}
    
    ${isTs ? `
    ; Capture TS specific types
    (interface_declaration name: (type_identifier) @interface_name)
    (type_alias_declaration name: (type_identifier) @type_name)
    (enum_declaration name: (identifier) @enum_name)
    
    ; Capture Type References
    (type_annotation (type_identifier) @type_reference)
    (type_arguments (type_identifier) @type_reference)
    ` : ""}
    
    ; Capture all named function definitions
    [
      (function_declaration name: (_) @func_name)
      (method_definition name: (_) @method_name)
      (variable_declarator 
        name: (identifier) @var_func_name 
        value: [(arrow_function) (function_expression)]
      )
      (lexical_declaration
        (variable_declarator
          name: (identifier) @lex_func_name
          value: [(arrow_function) (function_expression)]
        )
      )
    ]

    (call_expression function: (identifier) @call_name)
    (call_expression
      function: (member_expression
        object: (_) @call_method_object
        property: (property_identifier) @call_method_name
      )
    )
    
    ; Capture object instantiations
    (new_expression constructor: (_) @constructor_name)
  `;

  const query = new Query(language, baseQueryString);
  const matches = query.matches(tree.rootNode);

  // Helper: walk up the AST to find the enclosing named function/method
  const getEnclosingFunction = (node: Parser.SyntaxNode): string | null => {
    let current = node.parent;
    while (current) {
      if (
        current.type === "function_declaration" ||
        current.type === "method_definition"
      ) {
        const nameNode = current.childForFieldName("name");
        if (nameNode) return nameNode.text;
      } else if (current.type === "variable_declarator") {
        const valueNode = current.childForFieldName("value");
        if (
          valueNode &&
          (valueNode.type === "arrow_function" ||
            valueNode.type === "function_expression")
        ) {
          const nameNode = current.childForFieldName("name");
          if (nameNode) return nameNode.text;
        }
      }
      current = current.parent;
    }
    return null;
  };

  const getEnclosingClass = (node: Parser.SyntaxNode): string | null => {
    let current = node.parent;
    while (current) {
      if (
        current.type === "class_declaration" ||
        current.type === "abstract_class_declaration" ||
        current.type === "interface_declaration"
      ) {
        const nameNode = current.childForFieldName("name");
        if (nameNode) return nameNode.text;
      }
      current = current.parent;
    }
    return null;
  };

  for (const match of matches) {
    for (const capture of match.captures) {
      const name = capture.name;
      const node = capture.node;

      if (name === "import_source" || name === "require_source") {
        const importPath = node.text.replace(/['"]/g, "");
        const importLine = node.startPosition.row + 1;

        // Normalize: strip 'node:' protocol prefix
        // e.g. 'node:fs' → 'fs', 'node:fs/promises' → 'fs/promises'
        const normalizedImportPath = importPath.replace(/^node:/, "");

        // Extract the root module name to handle subpath imports:
        // 'fs/promises' → 'fs', 'path/posix' → 'path', '@/utils' → '@'
        // Note: '@scope/pkg' root is '@scope' which is never a built-in, so no false positives.
        const rootModule = normalizedImportPath.split("/")[0] as string;

        // Detect Node.js built-in imports — ONLY for bare specifiers (no './', '/', '@/', '~/' etc.)
        const isNativeModule =
          !importPath.startsWith(".") &&
          !importPath.startsWith("/") &&
          (NODE_CORE_MODULES.has(normalizedImportPath) ||
            NODE_CORE_MODULES.has(rootModule));

        if (isNativeModule) continue;

        // Try to resolve the import to a real file node using the file system.
        // This handles the .js → .ts extension mismatch TypeScript uses.
        const resolvedId = resolveImportToNode(importPath, filePath);

        if (resolvedId) {
          // The localGraph is isolated per file. We must add a stub node for the target
          // so graphology doesn't throw "target node not found". The parent process 
          // merges this stub with the real file node later.
          if (!graph.hasNode(resolvedId)) {
            graph.addNode(resolvedId, {
              type: "file",
              name: path.basename(resolvedId),
            });
          }
          graph.addEdge(filePath, resolvedId, {
            type: "imports",
            confidence: "EXTRACTED",
          });
        } else {
          // Third-party package (e.g. chalk, commander) — create an annotated ghost node
          const targetNodeId = `import::${importPath}`;
          if (!graph.hasNode(targetNodeId)) {
            graph.addNode(targetNodeId, {
              type: "file",
              name: importPath,
              metadata: {
                external: true,
                // Store who imported this and from which line for traceability
                callerFile: filePath,
                callerLine: importLine,
              },
            });
          }
          graph.addEdge(filePath, targetNodeId, {
            type: "imports",
            confidence: "EXTRACTED",
          });
        }
      } else if (name === "class_decl" || name === "class_name") {
        // If we captured the whole decl, find the name child
        const nameNode = name === "class_decl" 
          ? node.childForFieldName("name") 
          : node;
        
        if (!nameNode) continue;
        const className = nameNode.text;
        const classId = `${filePath}::class::${className}`;

        if (!graph.hasNode(classId)) {
          let doc = "";
          // If we captured the decl, use it; otherwise use node.parent
          const declNode = name === "class_decl" ? node : node.parent;
          if (declNode?.previousSibling?.type === "comment") {
            doc = declNode.previousSibling.text;
          }
          graph.addNode(classId, {
            type: "class",
            name: className,
            metadata: {
              doc,
              startLine: declNode
                ? declNode.startPosition.row + 1
                : nameNode.startPosition.row + 1,
              endLine: declNode
                ? declNode.endPosition.row + 1
                : nameNode.endPosition.row + 1,
            },
          });
          graph.addEdge(filePath, classId, {
            type: "defines",
            confidence: "EXTRACTED",
          });

          // Extract Inheritance (extends / implements)
          if (declNode) {
            const heritage = declNode.children.find((c) => c.type === "class_heritage");
            if (heritage) {
              const extendsClause = heritage.children.find((c) => c.type === "extends_clause");
              if (extendsClause) {
                const idNode = extendsClause.children.find((c) => c.type === "identifier" || c.type === "type_identifier");
                if (idNode) {
                  const baseName = idNode.text;
                  const targetId = `unresolved_symbol::${baseName}`;
                  if (!graph.hasNode(targetId)) {
                    graph.addNode(targetId, { type: "class", name: baseName, unresolved: true });
                  }
                  graph.addEdge(classId, targetId, { type: "extends", confidence: "EXTRACTED" });
                }
              }

              const implementsClause = heritage.children.find((c) => c.type === "implements_clause");
              if (implementsClause) {
                const idNodes = implementsClause.children.filter((c) => c.type === "type_identifier" || c.type === "identifier");
                for (const idNode of idNodes) {
                  const interfaceName = idNode.text;
                  const targetId = `unresolved_symbol::${interfaceName}`;
                  if (!graph.hasNode(targetId)) {
                    graph.addNode(targetId, { type: "interface", name: interfaceName, unresolved: true });
                  }
                  graph.addEdge(classId, targetId, { type: "implements", confidence: "EXTRACTED" });
                }
              }
            }
          }
        }
      } else if (
        name === "func_name" ||
        name === "method_name" ||
        name === "var_func_name" ||
        name === "lex_func_name"
      ) {
        const funcName = node.text;
        const funcId = `${filePath}::function::${funcName}`;
        if (!graph.hasNode(funcId)) {
          let doc = "";
          let declNode: Parser.SyntaxNode | null = node.parent;
          let statementNode: Parser.SyntaxNode | null = node.parent;
          
          if (name === "var_func_name" || name === "lex_func_name") {
            declNode = node.parent; // variable_declarator
            statementNode = node.parent?.parent || node.parent; // lexical_declaration or variable_declaration
          }

          if (statementNode?.previousSibling?.type === "comment") {
            doc = statementNode.previousSibling.text;
          }
          graph.addNode(funcId, {
            type: "function",
            name: funcName,
            metadata: {
              doc,
              startLine: declNode
                ? declNode.startPosition.row + 1
                : node.startPosition.row + 1,
              endLine: declNode
                ? declNode.endPosition.row + 1
                : node.endPosition.row + 1,
            },
          });
          graph.addEdge(filePath, funcId, {
            type: "defines",
            confidence: "EXTRACTED",
          });
        }
      } else if (name === "type_name" || name === "interface_name" || name === "enum_name") {
        const typeName = node.text;
        const nodeType = name === "enum_name" ? "enum" : (name === "interface_name" ? "interface" : "type");
        const typeId = `${filePath}::${nodeType}::${typeName}`;
        if (!graph.hasNode(typeId)) {
          let doc = "";
          const declNode = node.parent;
          if (declNode?.previousSibling?.type === "comment") {
            doc = declNode.previousSibling.text;
          }
          graph.addNode(typeId, {
            type: nodeType,
            name: typeName,
            metadata: {
              doc,
              startLine: declNode ? declNode.startPosition.row + 1 : node.startPosition.row + 1,
              endLine: declNode ? declNode.endPosition.row + 1 : node.endPosition.row + 1,
            },
          });
          graph.addEdge(filePath, typeId, {
            type: "defines",
            confidence: "EXTRACTED",
          });
        }
      } else if (name === "type_reference") {
        const typeName = node.text;
        if (["string", "number", "boolean", "any", "unknown", "void", "never", "null", "undefined",
             "Date", "Array", "Record", "Promise", "Map", "Set", "Buffer", "RegExp",
             "Partial", "Required", "Readonly", "Pick", "Omit", "Exclude", "Extract",
             "NonNullable", "ReturnType", "Parameters", "InstanceType", "Awaited",
             "Object", "Function", "Symbol", "Error", "TypeError", "RangeError",
             "T", "K", "V", "U", "P", "R", "S"].includes(typeName)) continue;

        const sourceFn = getEnclosingFunction(node);
        const sourceCls = getEnclosingClass(node);
        
        let callerId = "";
        if (sourceFn) {
          callerId = `${filePath}::function::${sourceFn}`;
        } else if (sourceCls) {
          callerId = `${filePath}::class::${sourceCls}`;
        }

        if (callerId && graph.hasNode(callerId)) {
          const targetId = `unresolved_symbol::${typeName}`;
          if (!graph.hasNode(targetId)) {
            graph.addNode(targetId, {
              type: "type",
              name: typeName,
              unresolved: true,
            });
          }
          if (!graph.hasEdge(callerId, targetId)) {
            graph.addEdge(callerId, targetId, { type: "references", confidence: "EXTRACTED" });
          }
        }
      } else if (name === "call_method_name") {
        // Method calls (e.g. graph.mergeNodeAttributes()) are receiver-scoped
        // and don't represent project-level function definitions.
        // We skip ghost node creation — only bare calls and constructors
        // get unresolved nodes.
        continue;
      } else if (name === "call_name" || name === "constructor_name") {
        // Bare function calls: scanDirectory(), parseFile(), require(), etc.
        // OR object instantiations: new ClassName()
        const calledName = node.text;

        // Skip ECMAScript / Node.js built-ins
        if (BUILT_INS.has(calledName)) continue;

        const callLine = node.startPosition.row + 1;
        const callerName = getEnclosingFunction(node);
        const callerId = callerName
          ? `${filePath}::function::${callerName}`
          : filePath;

        const targetFuncId = `unresolved_symbol::${calledName}`;
        if (!graph.hasNode(targetFuncId)) {
          graph.addNode(targetFuncId, {
            type: name === "constructor_name" ? "class" : "function",
            name: calledName,
            metadata: {
              external: true,
              unresolved: true,
              reason:
                "Called/Instantiated but not defined in any scanned file. Likely from an external package or a dynamic import.",
              callerFile: filePath,
              callerLine: callLine,
            },
          });
        }

        if (!graph.hasNode(callerId)) {
          graph.addNode(callerId, {
            type: "function",
            name: callerName || "anonymous",
          });
          graph.addEdge(filePath, callerId, {
            type: "defines",
            confidence: "EXTRACTED",
          });
        }

        if (!graph.hasEdge(callerId, targetFuncId)) {
          graph.addEdge(callerId, targetFuncId, {
            type: "calls",
            confidence: "AMBIGUOUS",
          });
        }
      }
    }
  }
}

