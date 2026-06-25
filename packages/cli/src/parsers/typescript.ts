import Parser from "web-tree-sitter";
type Language = Parser.Language;
type Node = Parser.SyntaxNode;
import fs from "fs";
import path from "path";
import { builtinModules } from "module";
import type { MultiDirectedGraph } from "graphology";
import { NodeData, EdgeData, NodeType } from "../core/graph.js";

const NODE_CORE_MODULES = new Set(builtinModules);

const BUILT_INS = new Set<string>();

// 1. Gather all core JS engine globals dynamically
Object.getOwnPropertyNames(globalThis).forEach(p => BUILT_INS.add(p));

// 2. Gather static and instance prototype methods from core JS classes
const CORE_CLASSES: unknown[] = [
  Object, Array, String, Number, Boolean, Symbol, Promise, Date, RegExp, Map, Set,
  Error, ArrayBuffer, DataView, Function
];
if (typeof Intl !== "undefined") {
  CORE_CLASSES.push(Intl);
}
for (const cls of CORE_CLASSES) {
  if (cls && (typeof cls === "function" || typeof cls === "object")) {
    Object.getOwnPropertyNames(cls).forEach(p => BUILT_INS.add(p));
    const proto = (cls as { prototype?: unknown }).prototype;
    if (proto && (typeof proto === "object" || typeof proto === "function")) {
      Object.getOwnPropertyNames(proto).forEach(p => BUILT_INS.add(p));
    }
  }
}

// 3. Static set of common browser/DOM environment globals, types, and methods
const BROWSER_DOM_BUILT_INS = [
  // Browser Globals
  "window", "document", "navigator", "location", "history", "screen",
  "localStorage", "sessionStorage", "fetch", "Headers", "Request", "Response",
  "setTimeout", "clearTimeout", "setInterval", "clearInterval",
  "requestAnimationFrame", "cancelAnimationFrame", "alert", "confirm", "prompt",
  
  // DOM & HTML Interfaces/Types
  "Event", "CustomEvent", "Node", "Element", "HTMLElement", "CSSProperties",
  "HTMLDivElement", "HTMLSpanElement", "HTMLInputElement", "HTMLButtonElement",
  "HTMLCanvasElement", "HTMLVideoElement", "HTMLAudioElement", "HTMLImageElement",
  "HTMLAnchorElement", "HTMLFormElement", "SVGElement", "Blob", "File", "FileList",
  "FileReader", "FormData", "Audio", "AudioContext", "webkitAudioContext",
  "BroadcastChannel", "IntersectionObserver", "ResizeObserver", "MutationObserver",
  "Timeout", "CanvasTextBaseline",
  
  // Common DOM Methods & Properties
  "closest", "blur", "focus", "click", "select", "querySelector", "querySelectorAll",
  "getElementById", "getElementsByClassName", "getElementsByTagName", "createElement",
  "appendChild", "removeChild", "replaceChild", "insertBefore", "cloneNode", "contains",
  "getAttribute", "setAttribute", "removeAttribute", "classList", "addEventListener",
  "removeEventListener", "dispatchEvent", "preventDefault", "stopPropagation",
  "getBoundingClientRect", "postMessage"
];
BROWSER_DOM_BUILT_INS.forEach(p => BUILT_INS.add(p));

const TYPESCRIPT_UTILITY_TYPES = [
  "Partial", "Required", "Readonly", "Record", "Pick", "Omit", "Exclude", "Extract",
  "NonNullable", "Parameters", "ConstructorParameters", "ReturnType", "InstanceType",
  "ThisParameterType", "OmitThisParameter", "ThisType", "Awaited", "NodeJS"
];
TYPESCRIPT_UTILITY_TYPES.forEach(p => BUILT_INS.add(p));

function findNearestPackageJson(dir: string): string {
  let current = dir;
  while (true) {
    const candidate = path.join(current, "package.json");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return "";
}

function getBasePackageName(importPath: string): string {
  if (importPath.startsWith(".") || importPath.startsWith("/")) {
    return importPath;
  }
  const normalized = importPath.replace(/^node:/, "");
  const parts = normalized.split("/");
  if (normalized.startsWith("@")) {
    if (parts.length >= 2) {
      return `${parts[0]}/${parts[1]}`;
    }
  } else {
    if (parts.length >= 1) {
      return parts[0] as string;
    }
  }
  return importPath;
}

function resolveImportToNode(importPath: string, sourceFilePath: string, aliases: import("../core/types.js").PathAlias[] = []): string | null {
  const checkCandidates = (resolvedBase: string) => {
    const candidates: string[] = [
      resolvedBase + ".ts",
      resolvedBase + ".tsx",
      resolvedBase + "/index.ts",
      resolvedBase + "/index.tsx",
      resolvedBase + ".js",
      resolvedBase + ".jsx",
      resolvedBase + "/index.js",
      resolvedBase + "/index.jsx",
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return candidate;
    }
    return null;
  };

  const normalizedImport = importPath.replace(/\.js$/, "");

  if (importPath.startsWith(".")) {
    const sourceDir = path.dirname(sourceFilePath);
    const resolvedBase = path.resolve(sourceDir, normalizedImport);
    return checkCandidates(resolvedBase);
  }

  if (aliases && aliases.length > 0) {
    for (const alias of aliases) {
      if (importPath.startsWith(alias.prefix)) {
        const remainder = normalizedImport.slice(alias.prefix.length);
        for (const target of alias.targets) {
          const resolvedBase = path.join(target, remainder);
          const found = checkCandidates(resolvedBase);
          if (found) return found;
        }
      }
    }
  }

  return null;
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
    if (
      patternNode.type === "identifier" ||
      patternNode.type === "shorthand_property_identifier" ||
      patternNode.type === "shorthand_property_identifier_pattern" ||
      patternNode.type === "type_identifier"
    ) {
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
      current.type === "arrow_function" ||
      current.type === "function_expression" ||
      current.type === "method_definition" ||
      current.type === "class_declaration" ||
      current.type === "abstract_class_declaration" ||
      current.type === "interface_declaration" ||
      current.type === "type_alias_declaration"
    ) {
      const paramsNode = current.childForFieldName("parameters") || current.namedChildren.find(c => c.type === "formal_parameters" || c.type === "parameter_list");
      if (paramsNode && checkPattern(paramsNode)) {
        return true;
      }
      if (current.type === "arrow_function") {
        const firstChild = current.namedChild(0);
        if (firstChild && firstChild.type === "identifier" && firstChild.text.trim() === name) {
          return true;
        }
      }
      const typeParamsNode = current.childForFieldName("type_parameters") || current.namedChildren.find(c => c.type === "type_parameters");
      if (typeParamsNode && checkPattern(typeParamsNode)) {
        return true;
      }
    }

    if (current.type === "mapped_type_clause") {
      const typeParamsNode = current.childForFieldName("parameter") || current.namedChildren.find(c => c.type === "type_identifier");
      if (typeParamsNode && typeParamsNode.text.trim() === name) {
        return true;
      }
    }

    if (current.type === "statement_block" || current.type === "program") {
      for (let i = 0; i < current.namedChildCount; i++) {
        const statement = current.namedChild(i);
        if (!statement) continue;

        if (statement.type === "lexical_declaration" || statement.type === "variable_declaration") {
          for (let j = 0; j < statement.namedChildCount; j++) {
            const declarator = statement.namedChild(j);
            if (declarator && declarator.type === "variable_declarator") {
              const nameNode = declarator.childForFieldName("name");
              if (nameNode && checkPattern(nameNode)) {
                return true;
              }
            }
          }
        }
      }
    }

    current = current.parent;
  }
  return false;
}

export function parseTypeScript(
  filePath: string,
  graph: MultiDirectedGraph<NodeData, EdgeData>,
  languageMap: {
    typescript: Language;
    tsx: Language;
    javascript: Language;
  },
  aliases: import("../core/types.js").PathAlias[] = []
) {
  const isTs = filePath.endsWith(".ts") || filePath.endsWith(".tsx");
  const isTsx = filePath.endsWith(".tsx");

  let language: Language;
  if (isTs) {
    language = isTsx ? languageMap.tsx : languageMap.typescript;
  } else {
    language = languageMap.javascript;
  }

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

  const importMap = new Map<string, string>();
  const importOriginalNameMap = new Map<string, string>();
  const localDefinitions = new Set<string>(); 
  const localMethodMap = new Map<string, string[]>();

  const baseQueryString = `
    (import_statement (import_clause (identifier) @default_import) source: (string) @import_source)
    (import_statement (import_clause (namespace_import (identifier) @namespace_import)) source: (string) @import_source)
    (import_statement (import_clause (named_imports (import_specifier) @named_import_specifier)) source: (string) @import_source)
    (import_statement source: (string) @import_source)
    (import) @import_source
    
    (call_expression
      function: (identifier) @req_fn
      arguments: (arguments (string) @require_source)
      (#eq? @req_fn "require")
    )
    
    ${isTs ? "[(class_declaration) (abstract_class_declaration)] @class_decl" : "(class_declaration) @class_decl"}
    
    ${isTs ? `
    (interface_declaration name: (type_identifier) @interface_name)
    (type_alias_declaration name: (type_identifier) @type_name)
    (enum_declaration name: (identifier) @enum_name)
    
    (type_identifier) @type_reference
    ` : ""}
    
    [
      (function_declaration name: (_) @func_name)
      (method_definition name: (_) @method_name)
      (variable_declarator 
        name: (identifier) @var_func_name 
        value: [(arrow_function) (function_expression)]
      )
    ]

    (call_expression function: (identifier) @call_name)
    (call_expression
      function: (member_expression
        object: (_) @call_method_object
        property: (property_identifier) @call_method_name
      )
    )
    (new_expression constructor: [
      (identifier)
      (member_expression)
    ] @constructor_name)
  `;

  const query = language.query(baseQueryString);
  const matches = query.matches(tree.rootNode);

  const getEnclosingScopePath = (startNode: Node | null | undefined): string => {
    const pathParts: string[] = [];
    let current = startNode;
    while (current) {
      if (
        current.type === "class_declaration" ||
        current.type === "abstract_class_declaration" ||
        current.type === "interface_declaration" ||
        current.type === "type_alias_declaration" ||
        current.type === "enum_declaration" ||
        current.type === "function_declaration" ||
        current.type === "method_definition"
      ) {
        const nameNode = current.childForFieldName("name");
        if (nameNode) {
          pathParts.unshift(nameNode.text.trim());
        }
      } else if (current.type === "variable_declarator") {
        const valNode = current.childForFieldName("value");
        if (valNode && (valNode.type === "arrow_function" || valNode.type === "function_expression")) {
          if (startNode && startNode.startIndex >= valNode.startIndex && startNode.endIndex <= valNode.endIndex) {
            const nameNode = current.childForFieldName("name");
            if (nameNode) {
              pathParts.unshift(nameNode.text.trim());
            }
          }
        }
      }
      current = current.parent;
    }
    return pathParts.join(".");
  };

  // 1. First pass: Collect imports AND local definitions
  for (const match of matches) {
    let currentSource = "";
    for (const capture of match.captures) {
      if (capture.name === "import_source") {
        currentSource = capture.node.text.replace(/['"]/g, "");
        if (capture.node.parent?.type === "import_expression" || capture.node.parent?.type === "call_expression") {
          let parent: Node | null = capture.node.parent;
          while (parent && parent.type !== "variable_declarator") {
            parent = parent.parent;
          }
          if (parent) {
            const nameNode = parent.childForFieldName("name");
            if (nameNode) {
              if (nameNode.type === "identifier") {
                importMap.set(nameNode.text, currentSource);
              } else if (nameNode.type === "object_pattern") {
                const identifiers: string[] = [];
                const extractIds = (n: Node) => {
                  if (n.type === "identifier" || n.type === "shorthand_property_identifier") {
                    identifiers.push(n.text);
                  }
                  for (let i = 0; i < n.namedChildCount; i++) {
                    const child = n.namedChild(i);
                    if (child) extractIds(child);
                  }
                };
                extractIds(nameNode);
                for (const id of identifiers) {
                  importMap.set(id, currentSource);
                }
              }
            }
          }
        }
      } else if (capture.name === "require_source") {
        currentSource = capture.node.text.replace(/['"]/g, "");
        let parent: Node | null = capture.node.parent;
        while (parent && parent.type !== "variable_declarator") {
          parent = parent.parent;
        }
        if (parent) {
          const nameNode = parent.childForFieldName("name");
          if (nameNode && nameNode.type === "identifier") {
            importMap.set(nameNode.text, currentSource);
          }
        }
      }
    }
    if (currentSource) {
      for (const capture of match.captures) {
        if (capture.name === "default_import" || capture.name === "namespace_import") {
          importMap.set(capture.node.text.trim(), currentSource);
        } else if (capture.name === "named_import_specifier") {
          const aliasNode = capture.node.childForFieldName("alias");
          const nameNode = capture.node.childForFieldName("name");
          const localName = aliasNode ? aliasNode.text.trim() : (nameNode ? nameNode.text.trim() : "");
          const originalName = nameNode ? nameNode.text.trim() : "";
          if (localName) {
            importMap.set(localName, currentSource);
            if (originalName && originalName !== localName) {
              importOriginalNameMap.set(localName, originalName);
            }
          }
        }
      }
    }
    for (const capture of match.captures) {
      if (["func_name", "method_name", "var_func_name", "class_decl", "interface_name", "type_name", "enum_name"].includes(capture.name)) {
        let finalSymName = capture.node.text.trim();
        if (capture.name === "class_decl" && (capture.node.type === "class_declaration" || capture.node.type === "abstract_class_declaration")) {
          const nameNode = capture.node.childForFieldName("name");
          if (nameNode) finalSymName = nameNode.text.trim();
        }
        localDefinitions.add(finalSymName);

        const scopePrefix = getEnclosingScopePath(capture.node.parent?.parent);
        const symId = scopePrefix ? `${filePath}::${scopePrefix}.${finalSymName}` : `${filePath}::${finalSymName}`;

        if (["func_name", "method_name", "var_func_name"].includes(capture.name)) {
          if (!localMethodMap.has(finalSymName)) {
            localMethodMap.set(finalSymName, []);
          }
          localMethodMap.get(finalSymName)!.push(symId);
        }
      }
    }
  }

  const getRootIdentifier = (node: Node | null): string => {
    if (!node) return "";
    if (node.type === "identifier" || node.type === "this") return node.text.trim();
    if (node.type === "member_expression") {
      return getRootIdentifier(node.childForFieldName("object"));
    }
    if (node.type === "call_expression") {
      return getRootIdentifier(node.childForFieldName("function"));
    }
    if (
      node.type === "await_expression" ||
      node.type === "parenthesized_expression" ||
      node.type === "non_null_expression" ||
      node.type === "as_expression"
    ) {
      return getRootIdentifier(node.namedChild(0));
    }
    return "";
  };

  // 2. Second pass: Build graph nodes and edges
  for (const match of matches) {
    for (const capture of match.captures) {
      const name = capture.name;
      const node = capture.node;

      if (name === "import_source" || name === "require_source") {
        const importPath = node.text.replace(/['"]/g, "");
        const importLine = node.startPosition.row + 1;
        const normalizedPath = importPath.replace(/^node:/, "");
        const rootModule = normalizedPath.split("/")[0] as string;

        if (!importPath.startsWith(".") && !importPath.startsWith("/") && (NODE_CORE_MODULES.has(normalizedPath) || NODE_CORE_MODULES.has(rootModule))) continue;

        const resolvedId = resolveImportToNode(importPath, filePath, aliases);
        const basePackage = getBasePackageName(importPath);
        const targetNodeId = resolvedId || `import::${basePackage}`;

        if (!graph.hasNode(targetNodeId)) {
          const nearestPkgJson = findNearestPackageJson(path.dirname(filePath));
          graph.addNode(targetNodeId, {
            type: "file",
            name: resolvedId ? path.basename(resolvedId) : basePackage,
            file: resolvedId || nearestPkgJson || filePath,
            startLine: 0,
            metadata: resolvedId ? {} : { external: true, callerFile: filePath, callerLine: importLine }
          });
        }
        graph.addEdge(filePath, targetNodeId, { type: "imports", confidence: "EXTRACTED" });

      } else if (["class_decl", "interface_name", "type_name", "enum_name", "func_name", "method_name", "var_func_name"].includes(name)) {
        let decl = node;
        if (decl.parent && ["function_declaration", "method_definition", "interface_declaration", "type_alias_declaration", "enum_declaration", "class_declaration", "abstract_class_declaration", "variable_declarator"].includes(decl.parent.type)) {
          decl = decl.parent;
        }
        if (decl.parent && ["export_statement", "lexical_declaration", "variable_declaration"].includes(decl.parent.type)) {
          decl = decl.parent;
        }
        if (decl.parent && ["export_statement"].includes(decl.parent.type)) {
          decl = decl.parent;
        }

        const comments: string[] = [];
        let prev = decl.previousNamedSibling;
        while (prev && prev.type === "comment") {
          comments.push(prev.text);
          prev = prev.previousNamedSibling;
        }
        
        let jsdoc: { doc: string; deprecated: boolean; links: string[] } | null = null;
        if (comments.length > 0) {
          comments.reverse();
          const docText = comments.join("\n");
          const links: string[] = [];
          const seeMatches = [...docText.matchAll(/@see\s+([^\s}]+)/g)];
          for (const m of seeMatches) if (m[1]) links.push(m[1].replace(/['"]/g, ""));
          const linkMatches = [...docText.matchAll(/{@link\s+([^\s}]+)/g)];
          for (const m of linkMatches) if (m[1]) links.push(m[1].replace(/['"]/g, ""));
          
          jsdoc = { doc: docText, deprecated: docText.includes("@deprecated"), links };
        }

        const symName = node.text.trim();
        let finalSymName = symName;
        if (name === "class_decl" && (node.type === "class_declaration" || node.type === "abstract_class_declaration")) {
          const nameNode = node.childForFieldName("name");
          if (nameNode) finalSymName = nameNode.text.trim();
        }
        
        const scopePrefix = getEnclosingScopePath(node.parent?.parent);
        const symId = scopePrefix ? `${filePath}::${scopePrefix}.${finalSymName}` : `${filePath}::${finalSymName}`;
        const parentId = scopePrefix ? `${filePath}::${scopePrefix}` : filePath;

        const typeMap: Record<string, NodeType> = {
          class_decl: "class", interface_name: "interface", type_name: "type", enum_name: "enum",
          func_name: "function", method_name: "function", var_func_name: "function"
        };

        const nodeAttrs = {
          type: typeMap[name] || "function",
          name: finalSymName,
          file: filePath,
          startLine: decl.startPosition.row + 1,
          metadata: { 
            endLine: decl.endPosition.row + 1,
            doc: jsdoc?.doc,
            deprecated: jsdoc?.deprecated || false,
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

        if (jsdoc && jsdoc.links.length > 0) {
          for (const link of jsdoc.links) {
            let targetPath = link;
            if (link.startsWith(".")) {
              targetPath = resolveImportToNode(link, filePath, aliases) || link;
            }
            
            if (!graph.hasNode(targetPath)) {
              graph.addNode(targetPath, { type: "file", name: path.basename(targetPath), file: targetPath, startLine: 0, metadata: { external: true } });
            }
            if (!graph.hasEdge(symId, targetPath)) {
              graph.addEdge(symId, targetPath, { type: "explains", confidence: "EXTRACTED" });
            }
          }
        }

      } else if (name === "type_reference") {
        const referencedTypeName = node.text.trim();
        
        let moduleName = "";
        if (node.parent?.type === "nested_type_identifier") {
          const moduleNode = node.parent.childForFieldName("module");
          if (moduleNode) {
            moduleName = moduleNode.text.trim();
          }
        }
        
        if (BUILT_INS.has(referencedTypeName) && !localDefinitions.has(referencedTypeName) && !importMap.has(referencedTypeName) && (!moduleName || BUILT_INS.has(moduleName))) continue;
        
        if (["interface_declaration", "type_alias_declaration", "import_specifier", "class_declaration", "function_declaration", "variable_declarator"].includes(node.parent?.type || "")) continue;

        if (isLocalDeclaration(node, referencedTypeName)) continue;

        const callerScope = getEnclosingScopePath(node.parent);
        const callerId = callerScope ? `${filePath}::${callerScope}` : filePath;
        const importSource = importMap.get(moduleName || referencedTypeName);
        
        const isCoreModule = importSource && (NODE_CORE_MODULES.has(importSource) || NODE_CORE_MODULES.has(importSource.replace(/^node:/, "")));
        if (isCoreModule) continue;

        let targetId: string;
        if (importSource) {
          const resolvedSource = resolveImportToNode(importSource, filePath, aliases) || importSource;
          const originalName = importOriginalNameMap.get(moduleName || referencedTypeName) || referencedTypeName;
          targetId = `${resolvedSource}::${originalName}`;
        } else if (localDefinitions.has(referencedTypeName)) {
          targetId = `${filePath}::${referencedTypeName}`;
        } else {
          targetId = `unresolved::${referencedTypeName}`;
        }

        const isUnresolved = !importSource && !localDefinitions.has(referencedTypeName);

        if (callerId === targetId) continue;

        if (!graph.hasNode(targetId)) {
          graph.addNode(targetId, {
            type: "interface",
            name: referencedTypeName,
            file: (importSource && resolveImportToNode(importSource, filePath, aliases)) || importSource || filePath,
            startLine: 0,
            metadata: { 
              external: !!importSource, 
              unresolved: isUnresolved, 
              endLine: 0,
              callerFile: isUnresolved ? filePath : undefined,
              callerLine: isUnresolved ? node.startPosition.row + 1 : undefined,
              doc: isUnresolved ? "Called/Instantiated but not defined in any scanned file. Likely from an external package or a dynamic import." : undefined
            }
          });
        }
        if (!graph.hasEdge(callerId, targetId)) {
          graph.addEdge(callerId, targetId, { type: "references", confidence: isUnresolved ? "AMBIGUOUS" : "EXTRACTED" });
        }

        if (importSource) {
          const baseImportSource = getBasePackageName(importSource);
          const resolvedSource = resolveImportToNode(importSource, filePath, aliases) || importSource;
          const importNodeId = resolveImportToNode(importSource, filePath, aliases) || `import::${baseImportSource}`;
          if (!graph.hasNode(importNodeId)) {
            const nearestPkgJson = findNearestPackageJson(path.dirname(filePath));
            graph.addNode(importNodeId, { 
              type: "file", 
              name: resolvedSource ? path.basename(resolvedSource) : baseImportSource, 
              file: resolvedSource || nearestPkgJson || filePath, 
              startLine: 0, 
              metadata: { external: true } 
            });
          }
          if (!graph.hasEdge(importNodeId, targetId)) {
            graph.addEdge(importNodeId, targetId, { type: "defines", confidence: "EXTRACTED" });
          }
        }

      } else if (name === "call_name" || name === "constructor_name" || name === "call_method_name") {
        const methodName = node.text.trim();
        let calledName = methodName;
        let objectName = "";

        if (name === "call_method_name" && node.parent?.type === "member_expression") {
          const objectNode = node.parent.childForFieldName("object");
          if (objectNode) {
            objectName = getRootIdentifier(objectNode);
            if (objectName) {
              calledName = `${objectName}.${calledName}`;
            }
          }
        }

        if (name === "call_method_name") {
          if (BUILT_INS.has(methodName) && !localDefinitions.has(methodName) && !importMap.has(methodName)) {
            continue;
          }
        }

        const baseName = objectName || calledName.split(".")[0] || "";
        if (BUILT_INS.has(baseName) && !localDefinitions.has(baseName) && !importMap.has(baseName)) continue;

        if (isLocalDeclaration(node, objectName || calledName)) continue;

        const callerScope = getEnclosingScopePath(node.parent);
        const callerId = callerScope ? `${filePath}::${callerScope}` : filePath;

        const targets: { id: string; confidence: "EXTRACTED" | "INFERRED" | "AMBIGUOUS" }[] = [];

        if (objectName) {
          const importSource = importMap.get(objectName);
          if (importSource) {
            const normalizedSource = importSource.replace(/^node:/, "");
            const rootModule = normalizedSource.split("/")[0] as string;
            const isCoreModule = !importSource.startsWith(".") && !importSource.startsWith("/") && (NODE_CORE_MODULES.has(normalizedSource) || NODE_CORE_MODULES.has(rootModule));
            if (isCoreModule) continue;

            const resolvedSource = resolveImportToNode(importSource, filePath, aliases) || importSource;
            targets.push({
              id: `${resolvedSource}::${methodName}`,
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
            // objectName is a local instance variable (e.g. logger.log())
            // Fuzzy match the method name against localMethodMap!
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
            }
          }
        } else {
          const importSource = importMap.get(calledName);
          if (importSource) {
            const normalizedSource = importSource.replace(/^node:/, "");
            const rootModule = normalizedSource.split("/")[0] as string;
            const isCoreModule = !importSource.startsWith(".") && !importSource.startsWith("/") && (NODE_CORE_MODULES.has(normalizedSource) || NODE_CORE_MODULES.has(rootModule));
            if (isCoreModule) continue;

            const resolvedSource = resolveImportToNode(importSource, filePath, aliases) || importSource;
            const originalName = importOriginalNameMap.get(calledName) || calledName;
            targets.push({
              id: `${resolvedSource}::${originalName}`,
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
              type: (name === "constructor_name" ? "class" : "function"),
              name: calledName,
              file: fileAttr,
              startLine: isExternal ? 0 : callLine,
              metadata: { 
                external: isExternal, 
                unresolved: isUnresolved, 
                endLine: isExternal ? 0 : callLine,
                callerFile: isUnresolved ? filePath : undefined,
                callerLine: isUnresolved ? callLine : undefined,
                doc: isUnresolved ? "Called/Instantiated but not defined in any scanned file. Likely from an external package or a dynamic import." : undefined
              }
            });
          }

          if (callerId === target.id) continue;
          if (!graph.hasEdge(callerId, target.id)) {
            graph.addEdge(callerId, target.id, { type: "calls", confidence: target.confidence });
          }
        }

        // Link external import package -> symbol
        const importSource = importMap.get(baseName);
        if (importSource) {
          const baseImportSource = getBasePackageName(importSource);
          const resolvedSource = resolveImportToNode(importSource, filePath, aliases) || importSource;
          const importNodeId = resolveImportToNode(importSource, filePath, aliases) || `import::${baseImportSource}`;
          if (!graph.hasNode(importNodeId)) {
            const nearestPkgJson = findNearestPackageJson(path.dirname(filePath));
            graph.addNode(importNodeId, {
              type: "file",
              name: resolvedSource ? path.basename(resolvedSource) : baseImportSource,
              file: resolvedSource || nearestPkgJson || filePath,
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
  }
}
