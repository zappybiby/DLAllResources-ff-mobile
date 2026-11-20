/* Build an inert local view while retaining the separately archived source bytes. */
globalThis.Offline = (() => {
  const svg = "http://www.w3.org/2000/svg";
  const svgPaintAttrs = ["fill", "stroke", "filter", "clip-path", "mask", "marker", "marker-start", "marker-mid", "marker-end", "cursor"];
  // Only this fixed script may run in the preview. It restores browser state
  // that HTML attributes cannot represent, such as the native modal top layer.
  const restoreState = `(() => {
  function restore(root) {
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) restore(el.shadowRoot);
      if (el.localName === 'dialog' && el.hasAttribute('data-export-modal') && el.open) {
        el.close();
        el.showModal();
      }
      if (el.hasAttribute('data-export-popover-open') && el.showPopover) el.showPopover();
      if (el.localName === 'input' && el.hasAttribute('data-export-indeterminate')) el.indeterminate = true;
      if (el.localName === 'select' && el.hasAttribute('data-export-no-selection')) el.selectedIndex = -1;
    }
  }
  restore(document);
})();`;
  const policy = [
    "default-src 'none'", "script-src 'sha256-/tSwMoxB3l8tk6BHMHKkESD9teo4+gccAW7CqedmgSY='", "style-src 'self' file: data: 'unsafe-inline'",
    "img-src 'self' file: data:", "font-src 'self' file: data:", "media-src 'self' file: data:",
    "frame-src about:", "object-src 'none'", "connect-src 'none'", "form-action 'none'", "base-uri 'none'"
  ].join("; ");

  function parse(html) {
    return new DOMParser().parseFromString(html, "text/html");
  }

  // querySelectorAll does not descend into saved declarative shadow roots.
  function* elements(root) {
    for (const el of root.querySelectorAll("*")) {
      yield el;
      if (el.localName === "template" && el.content) yield* elements(el.content);
    }
  }

  function absolute(value, base) {
    try { return new URL(value, base).href; } catch { return null; }
  }

  // The URL token in srcset can contain commas (especially in data: URLs).
  function candidates(text) {
    const result = [];
    let pos = 0;
    const space = /[\t\n\f\r ]/;
    while (pos < text.length) {
      while (pos < text.length && (space.test(text[pos]) || text[pos] === ",")) pos++;
      const start = pos;
      while (pos < text.length && !space.test(text[pos])) pos++;
      let ref = text.slice(start, pos);
      if (!ref) break;
      if (ref.endsWith(",")) {
        ref = ref.replace(/,+$/, "");
        if (ref) result.push({ref, descriptor: ""});
        continue;
      }
      const descriptorStart = pos;
      let depth = 0;
      while (pos < text.length && (depth || text[pos] !== ",")) {
        if (text[pos] === "(") depth++;
        if (text[pos] === ")" && depth) depth--;
        pos++;
      }
      result.push({ref, descriptor: text.slice(descriptorStart, pos).trim()});
    }
    return result;
  }

  function linkKind(el) {
    const rel = (el.getAttribute("rel") || "").toLowerCase().split(/\s+/);
    if (rel.includes("modulepreload")) return "js";
    if (rel.includes("stylesheet")) return "css";
    if (rel.includes("manifest")) return "manifest";
    if (rel.some(r => r === "icon" || r === "mask-icon" || r.startsWith("apple-touch-icon"))) return "asset";
    if (rel.includes("preload") || rel.includes("prefetch")) {
      const as = (el.getAttribute("as") || "").toLowerCase();
      const href = el.getAttribute("href") || "";
      if (!rel.includes("preload") && !as && !/\.(?:[cm]?js|css|woff2?|png|jpe?g|svg|webp)(?:[?#]|$)/i.test(href)) return null;
      if (["script", "worker", "sharedworker", "serviceworker", "audioworklet", "paintworklet"].includes(as)) return "js";
      return as === "style" ? "css" : as === "document" ? "html" : "asset";
    }
    return null;
  }

  function resourceAttrs(el) {
    const tag = el.localName;
    if (el.namespaceURI === svg) {
      return ["image", "use", "feImage", "script"].includes(tag)
        ? [["href", tag === "script" ? "js" : "asset"], ["xlink:href", tag === "script" ? "js" : "asset"]] : [];
    }
    switch (tag) {
      case "link": { const kind = linkKind(el); return kind ? [["href", kind]] : []; }
      case "script": return [["src", "js"]];
      case "input": return el.type === "image" ? [["src", "asset"]] : [];
      case "img": case "audio": case "source": case "track": case "embed": return [["src", "asset"]];
      case "video": return [["src", "asset"], ["poster", "asset"]];
      case "iframe": case "frame": return el.hasAttribute("srcdoc") ? [] : [["src", "html"]];
      case "object": return [["data", "asset"]];
      case "body": case "table": case "td": case "th": return [["background", "asset"]];
      default: return [];
    }
  }

  function htmlResources(html, documentURL) {
    const doc = parse(html);
    const base = absolute(doc.querySelector("base[href]")?.getAttribute("href") || documentURL, documentURL) || documentURL;
    const refs = [], inline = [], importMaps = [], seen = new Set();
    function add(value, kind, source) {
      if (!value || value.trim().startsWith("#")) return;
      const url = absolute(value, base);
      if (!url || /^(?:data|about|javascript):/i.test(url)) return;
      const key = kind + " " + url;
      if (!seen.has(key)) { refs.push({url, kind, source}); seen.add(key); }
    }
    for (const el of elements(doc)) {
      const tag = el.localName;
      for (const [attr, kind] of resourceAttrs(el)) {
        add(el.getAttribute(attr), kind, tag === "link" ? "link[rel=" + el.getAttribute("rel") + "]" : tag + "[" + attr + "]");
      }
      for (const attr of ["srcset", "imagesrcset"]) {
        if (el.hasAttribute(attr)) for (const item of candidates(el.getAttribute(attr))) add(item.ref, "asset", tag + "[" + attr + "]");
      }
      if (el.namespaceURI === svg) {
        for (const attr of svgPaintAttrs) {
          const text = el.getAttribute(attr);
          if (text?.includes("(")) inline.push({kind: "css", text, base});
        }
      }
      if (el.hasAttribute("style")) inline.push({kind: "css", text: el.getAttribute("style"), base});
      if (tag === "style") inline.push({kind: "css", text: el.textContent, base});
      if (tag === "script" && !el.hasAttribute("src")) {
        const type = (el.getAttribute("type") || "").trim().toLowerCase();
        if (type === "importmap") {
          try {
            const map = JSON.parse(el.textContent);
            if (map && typeof map === "object" && !Array.isArray(map)) importMaps.push({...map, base});
          } catch { /* The browser ignores malformed maps. */ }
        } else if (!type || type === "module" || /\b(?:javascript|ecmascript)\b/.test(type)) {
          inline.push({kind: "js", text: el.textContent, base});
        }
      }
    }
    return {refs, inline, importMaps};
  }

  function render(snapshot, lookup) {
    const base = snapshot.base || snapshot.url;
    const doc = parse(snapshot.html);
    function local(value) {
      const trimmed = String(value || "").trim();
      if (!trimmed) return null;
      if (trimmed.startsWith("#") || /^data:/i.test(trimmed)) return trimmed;
      const href = absolute(trimmed, base);
      if (!href) return null;
      const url = new URL(href);
      const fragment = url.hash;
      url.hash = "";
      const path = lookup(url.href);
      return path ? path.split("/").map(encodeURIComponent).join("/") + fragment : null;
    }
    function replaceAttr(el, attr) {
      if (!el.hasAttribute(attr)) return;
      const dest = local(el.getAttribute(attr));
      if (dest) el.setAttribute(attr, dest);
      else el.removeAttribute(attr);
    }
    function css(text) {
      return Deps.rewriteCSS(text, base, local);
    }
    function inertLink(el, attr) {
      const value = el.getAttribute(attr);
      if (!value) return;
      const href = absolute(value, base);
      const page = absolute(snapshot.url || base, base);
      if (href && page && href.includes("#") && href.split("#")[0] === page.split("#")[0]) {
        el.setAttribute(attr, href.slice(href.indexOf("#")));
      } else el.removeAttribute(attr);
    }
    for (const el of Array.from(elements(doc))) {
      const tag = el.localName;
      if (tag === "base" || (tag === "meta" && el.hasAttribute("http-equiv"))) {
        el.remove();
        continue;
      }
      for (const attr of el.getAttributeNames()) {
        if (/^on/i.test(attr) || ["nonce", "integrity", "crossorigin", "ping", "autofocus", "autoplay", "action", "formaction", "manifest", "attributionsrc"].includes(attr.toLowerCase())) {
          el.removeAttribute(attr);
        }
      }
      if (tag === "script") {
        el.setAttribute("type", "application/x-page-export-inert");
        for (const attr of ["src", "href", "xlink:href"]) replaceAttr(el, attr);
        continue;
      }
      if (tag === "iframe" || tag === "frame") {
        const childHTML = el.getAttribute("srcdoc");
        const childBase = el.getAttribute("data-export-frame-base") || base;
        el.removeAttribute("src");
        el.removeAttribute("srcdoc");
        if (tag === "iframe") {
          el.setAttribute("sandbox", "allow-same-origin allow-scripts");
          if (childHTML) el.setAttribute("srcdoc", render({html: childHTML, base: childBase, url: childBase}, lookup));
        }
        continue;
      }
      if (tag === "link") {
        const rel = (el.getAttribute("rel") || "").toLowerCase().split(/\s+/);
        const keep = ["stylesheet", "icon", "modulepreload", "preload", "prefetch"].find(token => rel.includes(token));
        if (!keep || !linkKind(el)) {
          el.removeAttribute("href");
          el.removeAttribute("imagesrcset");
          continue;
        }
        el.setAttribute("rel", keep === "stylesheet" && rel.includes("alternate") ? "alternate stylesheet" : keep);
      }
      if (tag === "a" || tag === "area") {
        for (const attr of ["href", "xlink:href"]) inertLink(el, attr);
      }
      if (tag === "object" || tag === "embed") {
        for (const attr of ["data", "src", "codebase", "archive"]) el.removeAttribute(attr);
      }
      for (const [attr] of resourceAttrs(el)) replaceAttr(el, attr);
      if (tag === "link" && ["modulepreload", "preload", "prefetch"].includes(el.getAttribute("rel"))) {
        el.setAttribute("data-export-rel", el.getAttribute("rel"));
        el.removeAttribute("rel");
      }
      for (const attr of ["srcset", "imagesrcset"]) {
        if (!el.hasAttribute(attr)) continue;
        const values = candidates(el.getAttribute(attr)).flatMap(({ref, descriptor}) => {
          const dest = local(ref);
          return dest ? [descriptor ? dest + " " + descriptor : dest] : [];
        });
        if (values.length) el.setAttribute(attr, values.join(", "));
        else el.removeAttribute(attr);
      }
      if (el.hasAttribute("data-export-current-src")) {
        const dest = local(el.getAttribute("data-export-current-src"));
        if (dest) {
          el.setAttribute("src", dest);
          el.removeAttribute("srcset");
          if (tag === "img" && el.parentElement?.localName === "picture") {
            for (const source of el.parentElement.querySelectorAll("source")) source.removeAttribute("srcset");
          }
        }
      }
      if (tag === "style") el.textContent = css(el.textContent);
      if (el.hasAttribute("style")) el.setAttribute("style", css(el.getAttribute("style")));
      if (el.namespaceURI === svg) {
        for (const attr of svgPaintAttrs) {
          if (el.hasAttribute(attr)) el.setAttribute(attr, css(el.getAttribute(attr)));
        }
      }
      if (tag === "canvas" && /^data:image\/png;base64,/i.test(el.getAttribute("data-export-canvas") || "")) {
        el.style.backgroundImage = 'url("' + el.getAttribute("data-export-canvas") + '")';
        el.style.backgroundSize = "100% 100%";
        el.removeAttribute("data-export-canvas");
      }
    }
    const restore = doc.createElement("script");
    restore.textContent = restoreState;
    if (doc.body) doc.body.appendChild(restore);
    const meta = doc.createElement("meta");
    meta.httpEquiv = "Content-Security-Policy";
    meta.content = policy;
    doc.head.prepend(meta);
    // This file always uses UTF-8, even when the original document used another encoding.
    for (const stale of doc.querySelectorAll("meta[charset]")) stale.remove();
    const charset = doc.createElement("meta");
    charset.setAttribute("charset", "utf-8");
    doc.head.prepend(charset);
    return (doc.doctype ? new XMLSerializer().serializeToString(doc.doctype) + "\n" : "") + doc.documentElement.outerHTML;
  }

  return {htmlResources, render};
})();
