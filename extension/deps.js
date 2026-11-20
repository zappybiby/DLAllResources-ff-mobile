/* Dependency discovery runs in the extension. Page code is only parsed, never evaluated. */
globalThis.Deps = (() => {
  "use strict";

  const urlLike = /^(?:[a-z][a-z0-9+.-]*:|\/|\.\.?\/)/i;

  function absolute(value, base) {
    try {
      return new URL(value, base).href;
    } catch {
      return null;
    }
  }

  function addMappings(table, mappings, base) {
    if (!mappings || typeof mappings !== "object") return;
    for (const [name, target] of Object.entries(mappings)) {
      if (!name) continue;
      const key = urlLike.test(name) ? absolute(name, base) : name;
      if (!key || table.has(key)) continue;
      const address = typeof target === "string" && urlLike.test(target) ? absolute(target, base) : null;
      table.set(key, address && (!key.endsWith("/") || address.endsWith("/")) ? address : null);
    }
  }

  function moduleResolver(maps, referrer) {
    const imports = new Map();
    const scopes = new Map();
    for (const map of maps || []) {
      if (!map || typeof map !== "object") continue;
      const base = map.base || referrer;
      addMappings(imports, map.imports, base);
      for (const [name, mappings] of Object.entries(map.scopes || {})) {
        const scope = absolute(name, base);
        if (!scope) continue;
        if (!scopes.has(scope)) scopes.set(scope, new Map());
        addMappings(scopes.get(scope), mappings, base);
      }
    }

    const matching = [...scopes.keys()]
      .filter(scope => referrer === scope || (scope.endsWith("/") && referrer.startsWith(scope)))
      .sort((a, b) => b.length - a.length)
      .map(scope => scopes.get(scope));
    const tables = [...matching, imports].map(table => ({
      table,
      prefixes: [...table.keys()].filter(key => key.endsWith("/")).sort((a, b) => b.length - a.length)
    }));

    return specifier => {
      const url = urlLike.test(specifier) ? absolute(specifier, referrer) : null;
      const name = url || specifier;
      for (const { table, prefixes } of tables) {
        if (table.has(name)) return table.get(name);
        for (const prefix of prefixes) {
          if (!name.startsWith(prefix)) continue;
          const target = table.get(prefix);
          if (!target) return null;
          const result = absolute(name.slice(prefix.length), target);
          return result && result.startsWith(target) ? result : null;
        }
      }
      return url;
    };
  }

  function literal(node) {
    if (node?.type === "Literal" && typeof node.value === "string") return node.value;
    if (node?.type === "TemplateLiteral" && !node.expressions.length) return node.quasis[0].value.cooked;
    return null;
  }

  function importMetaUrl(node) {
    return node?.type === "MemberExpression" &&
      node.object?.type === "MetaProperty" && node.object.meta.name === "import" &&
      node.object.property.name === "meta" &&
      (node.computed ? literal(node.property) === "url" : node.property.name === "url");
  }

  function moduleKind(node) {
    const attributes = node.attributes || node.assertions || [];
    const keyName = property => property?.key?.name || property?.key?.value;
    const options = node.options?.properties?.find(prop => keyName(prop) === "with");
    const type = (options?.value.properties || attributes).find(prop => keyName(prop) === "type")?.value.value;
    if (type === "json") return "asset";
    if (type === "css") return "css";
    return "js";
  }

  function scanJavaScript(text, base, maps, add, issue) {
    const options = { ecmaVersion: "latest", allowHashBang: true };
    let program;
    try {
      program = acorn.parse(text, { ...options, sourceType: "module" });
    } catch (moduleError) {
      try {
        program = acorn.parse(text, { ...options, sourceType: "script" });
      } catch {
        issue(base, "Could not parse JavaScript dependencies: " + moduleError.message);
        return;
      }
    }
    const resolveModule = moduleResolver(maps, base);
    const pending = [program];
    while (pending.length) {
      const node = pending.pop();
      if (node.type === "ImportExpression" || node.type === "ImportDeclaration" ||
          node.type === "ExportAllDeclaration" || (node.type === "ExportNamedDeclaration" && node.source)) {
        const specifier = literal(node.source);
        if (specifier === null) {
          issue(base, "Computed import() target at character " + node.start + ". Available runtime URLs are collected from the page.");
        } else {
          const resolved = resolveModule(specifier);
          if (resolved) add(resolved, moduleKind(node), node.type === "ImportExpression" ? "import()" : "module import");
          else issue(base, "Unresolved module specifier " + JSON.stringify(specifier));
        }
      } else if (node.type === "NewExpression" && node.callee.type === "Identifier" &&
                 node.callee.name === "URL" && importMetaUrl(node.arguments[1])) {
        const target = literal(node.arguments[0]);
        if (target !== null) {
          const url = absolute(target, base);
          if (url) add(url, "asset", "new URL with import.meta.url");
          else issue(base, "Invalid URL relative to import.meta.url: " + target);
        }
      }
      for (const key in node) {
        const child = node[key];
        if (Array.isArray(child)) {
          for (let i = child.length - 1; i >= 0; i--) if (child[i]?.type) pending.push(child[i]);
        } else if (child?.type) {
          pending.push(child);
        }
      }
    }
  }

  // Keep source ranges so rewritten stylesheets retain all unrelated formatting and rules.
  const isSpace = char => char !== undefined && /[ \n\t\f\r]/.test(char);
  const isHex = char => char !== undefined && /[a-fA-F0-9]/.test(char);
  const isName = char => char !== undefined && /[\w\u0080-\uffff-]/.test(char);
  const isQuote = char => char === '"' || char === "'";

  function escapeEnd(text, i) {
    let p = i + 1;
    if (isHex(text[p])) {
      const max = p + 6;
      while (p < max && isHex(text[p])) p++;
      if (!isSpace(text[p])) return p;
    }
    return p + (text[p] === "\r" && text[p + 1] === "\n" ? 2 : 1);
  }

  function cssUnescape(string) {
    return string.replace(/\\(?:([\da-fA-F]{1,6})(?:\r\n|[ \t\r\n\f])?|\r\n|([\s\S]))/g, (_, hex, char) => {
      if (!hex) return !char || /[\n\r\f]/.test(char) ? "" : char;
      const n = parseInt(hex, 16);
      return n && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : "\ufffd";
    });
  }

  function cssString(text, start) {
    let i = start + 1;
    while (i < text.length && text[i] !== text[start]) {
      if (/[\r\n\f]/.test(text[i])) return null;
      i = text[i] === "\\" ? escapeEnd(text, i) : i + 1;
    }
    if (i >= text.length) return null;
    return { start, end: i + 1, value: cssUnescape(text.slice(start + 1, i)) };
  }

  function cssReferences(text) {
    const found = [];
    const functions = [];
    let i = 0;
    let inImport = false;
    while (i < text.length) {
      if (text.startsWith("/*", i)) {
        const end = text.indexOf("*/", i + 2);
        i = end < 0 ? text.length : end + 2;
        continue;
      }
      const char = text[i];
      if (isSpace(char)) {
        i++;
        continue;
      }
      if (isQuote(char)) {
        const token = cssString(text, i);
        if (token && (inImport || /^(?:-webkit-)?image-set$/.test(functions.at(-1)))) {
          found.push({ ...token, kind: inImport ? "css" : "asset" });
        }
        i = token ? token.end : i + 1;
        inImport = false;
        continue;
      }
      if (isName(char) || char === "\\" || char === "@") {
        const start = i;
        if (char === "@") i++;
        while (i < text.length && (isName(text[i]) || text[i] === "\\")) {
          i = text[i] === "\\" ? escapeEnd(text, i) : i + 1;
        }
        const name = cssUnescape(text.slice(start, i)).toLowerCase();
        if (name === "@import") {
          inImport = true;
          continue;
        }
        if (name === "url" && text[i] === "(") {
          i++;
          while (isSpace(text[i])) i++;
          let token;
          if (isQuote(text[i])) {
            token = cssString(text, i);
            if (token) i = token.end;
          } else {
            const startValue = i;
            while (i < text.length && text[i] !== ")" && !isSpace(text[i])) {
              i = text[i] === "\\" ? escapeEnd(text, i) : i + 1;
            }
            token = { start: startValue, end: i, value: cssUnescape(text.slice(startValue, i)) };
          }
          while (isSpace(text[i])) i++;
          if (token && text[i] === ")") {
            found.push({ ...token, kind: inImport ? "css" : "asset" });
            i++;
          }
        } else if (text[i] === "(") {
          functions.push(name);
          i++;
        }
      } else {
        if (char === "(") functions.push("");
        if (char === ")") functions.pop();
        i++;
      }
      inImport = false;
    }
    return found;
  }

  function stylesheetURL(value, base) {
    if (!value || value.startsWith("#") || /^data:/i.test(value)) return null;
    return absolute(value, base);
  }

  function cssQuote(value) {
    return '"' + value.replace(/["\\\n\f\r]/g, char => {
      if (char === '"' || char === "\\") return "\\" + char;
      return "\\" + char.charCodeAt(0).toString(16) + " ";
    }) + '"';
  }

  function rewriteCSS(text, base, lookup) {
    let result = "";
    let last = 0;
    for (const token of cssReferences(text)) {
      const url = stylesheetURL(token.value, base);
      if (!url) continue;
      const parsed = new URL(url);
      const fragment = parsed.hash;
      parsed.hash = "";
      const relative = lookup(parsed.href);
      const replacement = relative == null ? "data:," : relative + fragment;
      result += text.slice(last, token.start) + cssQuote(replacement);
      last = token.end;
    }
    return result + text.slice(last);
  }

  function scan(text, kind, base, importMaps = []) {
    const refs = [], issues = [];
    const seen = new Set();
    const add = (url, type, source) => {
      if (url.startsWith("data:") || seen.has(type + "|" + url)) return;
      seen.add(type + "|" + url);
      refs.push({ url, kind: type, source });
    };
    const issue = (url, reason) => issues.push({ url, reason });
    if (kind === "css" || kind === "style" || kind === "stylesheet") {
      for (const token of cssReferences(text)) {
        const url = stylesheetURL(token.value, base);
        if (url) add(url, token.kind, token.kind === "css" ? "CSS @import" : "CSS asset");
      }
    } else if (["js", "javascript", "module", "script"].includes(kind)) {
      scanJavaScript(text, base, importMaps, add, issue);
    }
    return { refs, issues };
  }

  return { scan, rewriteCSS };
})();
