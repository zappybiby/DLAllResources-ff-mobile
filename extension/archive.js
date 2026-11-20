// Keep each member in an immutable Blob so assembling the ZIP can reuse its bytes.
globalThis.Archive = (() => {
  "use strict";

  const encoder = new TextEncoder();
  const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
    for (let bit = 0; bit < 8; bit++) {
      n = (n >>> 1) ^ ((n & 1) ? 0xedb88320 : 0);
    }
    return n;
  });

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) {
      crc = (crc >>> 8) ^ crcTable[(crc ^ bytes[i]) & 255];
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  const invalidChars = /[\x00-\x1f\x7f<>:"/\\|?*\u202a-\u202e\u2066-\u2069]/g;
  const reserved = /^(?:con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³]) *(?:\.|$)/i;
  const portableKey = name => name.normalize("NFKC").toUpperCase().normalize("NFC");

  function cleanSegment(name) {
    name = name.normalize("NFC").replace(invalidChars, "_").replace(/[. ]+$/g, "");
    // Some extractors normalize Unicode before creating files. Keep full-width
    // punctuation from turning into separators, traversal segments or devices.
    const compatible = name.normalize("NFKC");
    const safeCompatible = compatible.replace(invalidChars, "_").replace(/[. ]+$/g, "");
    if (safeCompatible !== compatible) name = safeCompatible;
    if (!name || reserved.test(safeCompatible)) name = "_" + name;
    return name;
  }

  function assertPath(path) {
    if (typeof path !== "string" || path.split("/").some(p => !p || p !== cleanSegment(p))) {
      throw new Error("Unsafe ZIP member path");
    }
  }

  class Zip {
    constructor() {
      this.entries = [];
      this.files = new Set();
      this.directories = new Set();
      this.offset = 0;
      this.centralSize = 0;
      const now = new Date();
      this.date = ((Math.min(2107, Math.max(1980, now.getFullYear())) - 1980) << 9) |
        ((now.getMonth() + 1) << 5) | now.getDate();
      this.time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >>> 1);
    }

    add(path, contents) {
      assertPath(path);
      const key = path.split("/").map(portableKey).join("/");
      const parents = [];
      for (let end = key.indexOf("/"); end >= 0; end = key.indexOf("/", end + 1)) {
        parents.push(key.slice(0, end));
      }
      if (this.files.has(key) || this.directories.has(key) || parents.some(p => this.files.has(p))) {
        throw new Error("Conflicting ZIP member: " + path);
      }
      const name = encoder.encode(path);
      let bytes;
      if (typeof contents === "string") bytes = encoder.encode(contents);
      else if (ArrayBuffer.isView(contents)) {
        bytes = new Uint8Array(contents.buffer, contents.byteOffset, contents.byteLength);
      } else if (contents instanceof ArrayBuffer) bytes = new Uint8Array(contents);
      else throw new TypeError("Expected text or bytes for " + path);

      const localSize = 30 + name.length + bytes.byteLength;
      const centralSize = 46 + name.length;
      if (this.entries.length >= 65534 || name.length > 65535 ||
          this.offset + localSize + this.centralSize + centralSize + 22 >= 0xffffffff) {
        throw new Error("Export exceeds classic ZIP size limits");
      }
      this.entries.push({ name, data: new Blob([bytes]), crc: crc32(bytes), offset: this.offset });
      this.offset += localSize;
      this.centralSize += centralSize;
      this.files.add(key);
      for (const parent of parents) this.directories.add(parent);
    }

    header(entry, central) {
      const start = central ? 46 : 30;
      const bytes = new Uint8Array(start + entry.name.length);
      const view = new DataView(bytes.buffer);
      const delta = central ? 2 : 0;
      view.setUint32(0, central ? 0x02014b50 : 0x04034b50, true);
      if (central) {
        view.setUint16(4, 20, true);
        view.setUint32(42, entry.offset, true);
      }
      view.setUint16(4 + delta, 20, true);
      view.setUint16(6 + delta, 0x800, true); // UTF-8 filenames.
      view.setUint16(10 + delta, this.time, true);
      view.setUint16(12 + delta, this.date, true);
      view.setUint32(14 + delta, entry.crc, true);
      view.setUint32(18 + delta, entry.data.size, true);
      view.setUint32(22 + delta, entry.data.size, true);
      view.setUint16(26 + delta, entry.name.length, true);
      bytes.set(entry.name, start);
      return bytes;
    }

    blob() {
      const parts = [];
      for (const entry of this.entries) parts.push(this.header(entry, false), entry.data);
      for (const entry of this.entries) parts.push(this.header(entry, true));
      const end = new DataView(new ArrayBuffer(22));
      end.setUint32(0, 0x06054b50, true);
      end.setUint16(8, this.entries.length, true);
      end.setUint16(10, this.entries.length, true);
      end.setUint32(12, this.centralSize, true);
      end.setUint32(16, this.offset, true);
      parts.push(end.buffer);
      return new Blob(parts, { type: "application/zip" });
    }
  }

  function decodeSegment(segment) {
    try { return decodeURIComponent(segment); }
    catch { return segment; }
  }

  function hash(value) {
    let h = 2166136261;
    for (let i = 0; i < value.length; i++) h = Math.imul(h ^ value.charCodeAt(i), 16777619);
    return (h >>> 0).toString(16).padStart(8, "0");
  }

  // Reserve space for suffixes and keep each UTF-8 component within common
  // filesystem limits, even when the original URL contains long Unicode names.
  function fit(name, suffix = "") {
    const dot = name.lastIndexOf(".");
    const hasExtension = dot > 0 && name.length - dot <= 16;
    const ext = hasExtension ? name.slice(dot) : "";
    const stem = hasExtension ? name.slice(0, dot) : name;
    const tail = suffix + ext;
    const budget = 220 - encoder.encode(tail).length;
    let size = 0;
    let prefix = "";
    for (const ch of stem) {
      size += encoder.encode(ch).length;
      if (size > budget) break;
      prefix += ch;
    }
    return cleanSegment(prefix + tail);
  }

  function node() { return { names: new Set(), children: new Map() }; }

  function allocate(parent, identity, requested, suffix = "") {
    const existing = parent.children.get(identity);
    if (existing) return existing;
    const clean = cleanSegment(requested);
    let name = fit(clean, suffix);
    let attempt = 0;
    while (parent.names.has(portableKey(name))) {
      const index = attempt++ ? "-" + attempt : "";
      name = fit(clean, "~" + hash(identity) + index);
    }
    const child = { name, ...node() };
    parent.names.add(portableKey(name));
    parent.children.set(identity, child);
    return child;
  }

  const extensions = {
    "text/html": "html", "text/css": "css", "text/javascript": "js",
    "application/javascript": "js", "application/json": "json",
    "image/svg+xml": "svg", "image/png": "png", "image/jpeg": "jpg",
    "image/gif": "gif", "image/webp": "webp", "image/avif": "avif",
    "font/woff": "woff", "font/woff2": "woff2", "application/wasm": "wasm",
    "audio/mpeg": "mp3", "video/mp4": "mp4"
  };

  class Paths {
    constructor() { this.root = node(); }

    forURL(value, mime = "") {
      const url = new URL(value);
      url.hash = "";
      const ext = extensions[(mime || "").toLowerCase().split(";")[0].trim()] || "bin";
      const isBlob = url.protocol === "blob:";
      const isData = url.protocol === "data:";
      const host = url.host || (isBlob && url.origin !== "null" ? new URL(url.origin).host : "");
      const origin = allocate(this.root, url.origin === "null" ? url.protocol : url.origin, host || "embedded");
      const path = ["assets", origin.name];
      let parent = origin;
      let segments;
      if (isData) segments = ["data", hash(url.href) + "." + ext];
      else if (isBlob) segments = ["blobs", url.pathname.split("/").pop() || hash(url.href)];
      else segments = url.pathname.replace(/^\//, "").split("/");
      const leaf = segments.pop() || "index." + ext;
      for (const segment of segments) {
        parent = allocate(parent, "directory:" + segment, decodeSegment(segment));
        path.push(parent.name);
      }
      const suffix = url.search ? "~" + hash(url.search) : "";
      const file = allocate(parent, "file:" + url.href, decodeSegment(leaf), suffix);
      path.push(file.name);
      return path.join("/");
    }
  }

  return { Zip, Paths };
})();
