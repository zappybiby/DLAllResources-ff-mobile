// Executed on demand in the already-open tab. All edits are made in an inert document.
(() => {
  const capturedAt = new Date().toISOString();
  const refs = [];
  const inline = [];
  const importMaps = [];
  const issues = [];
  const seenRefs = new Set();
  const seenIssues = new Set();
  const htmlNS = "http://www.w3.org/1999/xhtml";

  const svgPaintAttrs = ["fill", "stroke", "filter", "clip-path", "mask", "marker", "marker-start", "marker-mid", "marker-end", "cursor"];

  function issue(url, reason) {
    const key = JSON.stringify([url, reason]);
    if (!seenIssues.has(key)) {
      seenIssues.add(key);
      issues.push({url, reason});
    }
  }

  function add(raw, base, kind, source, cacheOnly = false) {
    if (typeof raw !== "string" || !raw.trim() || raw.trim().startsWith("#")) return;
    let url;
    try {
      url = new URL(raw, base);
    } catch {
      issue(raw, `Invalid resource URL in ${source}`);
      return;
    }
    if (url.protocol === "data:" || url.protocol === "about:") return;
    if (!["http:", "https:", "blob:", "file:"].includes(url.protocol)) {
      issue(url.href, `Unsupported resource protocol in ${source}`);
      return;
    }
    url.hash = "";
    const key = JSON.stringify([url.href, kind, source]);
    if (!seenRefs.has(key)) {
      seenRefs.add(key);
      refs.push(cacheOnly ? {url: url.href, kind, source, cacheOnly} : {url: url.href, kind, source});
    }
  }

  // URLs can contain commas, especially data: URLs. Descriptors start at whitespace.
  function srcsetURLs(value) {
    const urls = [];
    let i = 0;
    const space = /[\t\n\f\r ]/;
    while (i < value.length) {
      while (i < value.length && (space.test(value[i]) || value[i] === ",")) i++;
      const start = i;
      while (i < value.length && !space.test(value[i])) i++;
      const token = value.slice(start, i);
      if (!token) break;
      urls.push(token.replace(/,+$/, ""));
      if (token.endsWith(",")) continue;
      let depth = 0;
      while (i < value.length) {
        const ch = value[i++];
        if (ch === "(") depth++;
        else if (ch === ")" && depth) depth--;
        else if (ch === "," && !depth) break;
      }
    }
    return urls;
  }

  function addInline(text, kind, base) {
    if (text && text.trim()) inline.push({text, kind, base});
  }

  function collect(el, base) {
    const tag = el.localName.toLowerCase();
    const attr = name => el.getAttribute(name) || "";
    const from = (name, kind = "asset") => add(attr(name), base, kind, tag + "[" + name + "]");
    if (tag === "script") {
      from("src", "js");
      if (el.namespaceURI !== htmlNS) {
        add(attr("href") || attr("xlink:href"), base, "js", "svg script");
      }
      const type = attr("type").toLowerCase().trim();
      if (type === "importmap") {
        try {
          const map = JSON.parse(el.textContent);
          if (!map || typeof map !== "object" || Array.isArray(map)) throw Error();
          importMaps.push({imports: map.imports, scopes: map.scopes, base});
        } catch {
          issue(base, "Could not parse an inline import map");
        }
      } else if (!attr("src") && (!type || type === "module" || /(?:java|ecma)script/.test(type))) {
        addInline(el.textContent, "js", base);
      }
    } else if (tag === "link") {
      const rel = new Set(attr("rel").toLowerCase().trim().split(/\s+/));
      const as = attr("as").toLowerCase();
      let kind;
      if (rel.has("modulepreload")) kind = "js";
      else if (rel.has("stylesheet")) kind = "css";
      else if (rel.has("manifest")) kind = "manifest";
      else if (rel.has("preload") || rel.has("prefetch")) {
        // Prefetch may point to another page. Only follow static prefetch hints.
        if (rel.has("preload") || as || /\.(?:[cm]?js|css|woff2?|png|jpe?g|svg|webp)(?:[?#]|$)/i.test(attr("href"))) {
          kind = ["script", "worker", "sharedworker", "serviceworker", "audioworklet", "paintworklet"].includes(as)
            ? "js" : as === "style" ? "css" : "asset";
        }
      } else if ([...rel].some(token => token === "icon" || token === "mask-icon" || token.startsWith("apple-touch-icon"))) {
        kind = "asset";
      }
      if (kind) add(attr("href"), base, kind, "link rel=" + attr("rel"));
      for (const url of srcsetURLs(attr("imagesrcset"))) add(url, base, "asset", "link[imagesrcset]");
    } else if (tag === "style") {
      addInline(el.textContent, "css", base);
    } else if (["img", "source", "audio", "video", "embed", "track"].includes(tag) ||
               (tag === "input" && el.type === "image")) {
      from("src");
      if (tag === "video") from("poster");
      for (const url of srcsetURLs(attr("srcset"))) add(url, base, "asset", tag + "[srcset]");
    } else if (tag === "iframe" || tag === "frame") {
      if (!el.hasAttribute("srcdoc")) from("src", "html");
    } else if (tag === "object") {
      from("data");
    } else if (el.namespaceURI === "http://www.w3.org/2000/svg" && ["use", "image", "feimage"].includes(tag)) {
      add(attr("href") || attr("xlink:href"), base, "asset", "svg " + tag);
    }
    if (["body", "table", "td", "th"].includes(tag)) from("background");
    addInline(attr("style"), "css", base);
    if (el.namespaceURI === "http://www.w3.org/2000/svg") {
      for (const name of svgPaintAttrs) {
        const value = attr(name);
        if (value.includes("(")) addInline(value, "css", base);
      }
    }
    if (el.currentSrc) add(el.currentSrc, base, "asset", tag + ".currentSrc");
  }

  function cssText(sheet) {
    return Array.from(sheet.cssRules, rule => rule.cssText).join("\n");
  }

  function adoptedStyles(node, dest, inertDoc, base) {
    for (const sheet of node.adoptedStyleSheets || []) {
      try {
        const text = cssText(sheet);
        addInline(text, "css", base);
        if (!sheet.disabled) {
          const style = inertDoc.createElement("style");
          style.textContent = text.replace(/<\/style/gi, "<\\/style");
          if (sheet.media.mediaText) style.media = sheet.media.mediaText;
          dest.appendChild(style);
        }
      } catch {
        issue(base, "Could not read a constructed stylesheet");
      }
    }
  }

  function copyState(el, copy, base) {
    const tag = el.localName;
    if (tag === "input") {
      if (el.type === "file") {
        if (el.files?.length) {
          copy.setAttribute("data-export-files", JSON.stringify(Array.from(el.files, f => f.name)));
          issue(base, "Selected file input names saved without file contents");
        }
      } else {
        copy.setAttribute("value", el.value);
      }
      if (el.type === "checkbox" || el.type === "radio") copy.toggleAttribute("checked", el.checked);
      if (el.indeterminate) copy.setAttribute("data-export-indeterminate", "");
    } else if (tag === "textarea") {
      copy.textContent = el.value;
    } else if (tag === "select" && el.selectedIndex === -1) {
      copy.setAttribute("data-export-no-selection", "");
    } else if (tag === "option") {
      copy.toggleAttribute("selected", el.selected);
    } else if (tag === "dialog") {
      copy.toggleAttribute("open", el.open);
      if (el.matches(":modal")) copy.setAttribute("data-export-modal", "");
    } else if (tag === "canvas" && el.width && el.height) {
      try {
        copy.setAttribute("data-export-canvas", el.toDataURL());
      } catch {
        issue(base, "Could not read canvas pixels");
      }
    } else if (tag === "style" && el.sheet) {
      // insertRule() changes the CSSOM without changing the style element's text.
      try {
        const text = cssText(el.sheet);
        copy.textContent = text.replace(/<\/style/gi, "<\\/style");
        if (el.sheet.disabled) copy.setAttribute("media", "not all");
        if (text !== el.textContent) addInline(text, "css", base);
      } catch {
        // The original style text was already collected.
      }
    }
    if (el.currentSrc) copy.setAttribute("data-export-current-src", el.currentSrc);
    if (el.hasAttribute("popover") && el.matches(":popover-open")) {
      copy.setAttribute("data-export-popover-open", "");
    }
  }

  function timing(doc) {
    const staticTypes = new Set(["script", "link", "css", "img", "image", "video", "audio",
      "track", "font", "object", "embed", "input", "body", "icon", "imageset"]);
    try {
      for (const entry of doc.defaultView.performance.getEntriesByType("resource")) {
        const type = entry.initiatorType.toLowerCase();
        if (type === "fetch" || type === "xmlhttprequest") {
          // A GET issued now could differ from the page's original request.
          // Only a static-looking URL with available cached bytes qualifies.
          let path;
          try {
            path = new URL(entry.name).pathname.toLowerCase();
          } catch {
            continue;
          }
          if (/\.(?:[cm]?js|css|wasm|woff2?|ttf|otf|eot|svg|png|jpe?g|webp|avif|gif|ico|mp[34]|ogg|webm|vtt)$/.test(path)) {
            const kind = /\.[cm]?js$/.test(path) ? "js" : path.endsWith(".css") ? "css" : "asset";
            add(entry.name, doc.baseURI, kind, "resource timing (" + type + ")", true);
          }
          continue;
        }
        if (!staticTypes.has(type)) continue;
        const kind = type === "script" ? "js" : "asset";
        add(entry.name, doc.baseURI, kind, "resource timing (" + type + ")");
      }
    } catch {
      issue(doc.URL, "Could not read resource timing entries");
    }
  }

  function capture(doc) {
    const inertDoc = doc.createElement("template").content?.ownerDocument ||
                    document.createElement("template").content.ownerDocument;
    const root = inertDoc.importNode(doc.documentElement, true);
    const stack = [[doc.documentElement, root]];
    while (stack.length) {
      const [el, copy] = stack.pop();
      const base = el.baseURI || doc.baseURI;
      collect(el, base);
      if (el.namespaceURI === htmlNS) copyState(el, copy, base);

      // Queue light DOM children before adding generated frame/shadow/style content.
      const origChildren = el.content?.nodeType === 11 ? el.content : el;
      const copyChildren = copy.content?.nodeType === 11 ? copy.content : copy;
      for (let from = origChildren.lastElementChild, to = copyChildren.lastElementChild;
           from && to; from = from.previousElementSibling, to = to.previousElementSibling) {
        stack.push([from, to]);
      }
      if (el.shadowRoot) {
        const shadow = inertDoc.createElement("template");
        shadow.setAttribute("shadowrootmode", "open");
        if (el.shadowRoot.delegatesFocus) shadow.setAttribute("shadowrootdelegatesfocus", "");
        for (const child of el.shadowRoot.childNodes) {
          const clone = inertDoc.importNode(child, true);
          shadow.content.appendChild(clone);
          if (child.nodeType === 1) stack.push([child, clone]);
        }
        adoptedStyles(el.shadowRoot, shadow.content, inertDoc, base);
        copy.prepend(shadow);
      }
      if (el.namespaceURI === htmlNS && ["iframe", "frame"].includes(el.localName)) {
        try {
          const child = el.contentDocument;
          if (child?.documentElement) {
            copy.setAttribute("data-export-frame-base", child.baseURI);
            copy.setAttribute("srcdoc", capture(child));
          } else {
            issue(el.src || base, "Could not read embedded frame's live DOM");
          }
        } catch {
          issue(el.src || base, "Could not read embedded frame's live DOM");
        }
      }
    }
    adoptedStyles(doc, root.querySelector("head") || root, inertDoc, doc.baseURI);
    timing(doc);
    const doctype = doc.doctype ? new XMLSerializer().serializeToString(doc.doctype) + "\n" : "";
    return doctype + root.outerHTML;
  }

  const html = capture(document);
  let documentUrl = location.href;
  try {
    documentUrl = performance.getEntriesByType("navigation")[0]?.name || documentUrl;
  } catch {
    // Older contexts only expose the current location.
  }
  return {url: location.href, documentUrl, base: document.baseURI, title: document.title,
    html, refs, inline, importMaps, issues, charset: document.characterSet, capturedAt,
    readerId: globalThis.__exportZipReaderId || null};
})()
