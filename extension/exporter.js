globalThis.Exporter = (() => {
  const maxResources = 8192;
  const maxAssetBytes = 256 * 1024 * 1024;

  function normalized(url, base) {
    const parsed = new URL(url, base);
    parsed.hash = '';
    return parsed.href;
  }

  async function defaultRead(url, kind, options) {
    const sameOrigin = new URL(url).origin === location.origin;
    if (options.cacheOnly && !sameOrigin) throw new Error('Cross-origin page cache is unavailable');
    const cache = options.cacheOnly ? 'only-if-cached' : 'force-cache';
    const result = await ExportRead.get(url, kind, fetch, {
      cache, credentials: 'same-origin', mode: sameOrigin ? 'same-origin' : 'cors'
    });
    return {...result, retrieval: 'GET (' + cache + ')'};
  }

  function decode(bytes, mime, fallback) {
    const charset = /charset\s*=\s*["']?([^\s;"']+)/i.exec(mime)?.[1];
    try { return new TextDecoder(charset || fallback || 'utf-8').decode(bytes); }
    catch { return new TextDecoder().decode(bytes); }
  }

  function contentKind(expected, mime, url) {
    const path = new URL(url).pathname;
    if (/^(?:text\/html|application\/xhtml\+xml)\b/i.test(mime)) return 'html';
    if (expected !== 'asset') return expected;
    if (/javascript|ecmascript/i.test(mime) || /\.[cm]?js$/i.test(path)) return 'js';
    if (/^text\/css\b/i.test(mime) || /\.css$/i.test(path)) return 'css';
    if (/^application\/manifest\+json/i.test(mime) || /\.webmanifest$/i.test(path)) return 'manifest';
    return 'asset';
  }

  function relativeURL(fromFile, toFile) {
    const from = fromFile.split('/').slice(0, -1);
    const to = toFile.split('/');
    let n = 0;
    while (n < from.length && from[n] === to[n]) n++;
    return '../'.repeat(from.length - n) + to.slice(n).map(encodeURIComponent).join('/');
  }

  function sameBytes(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  // Keep one buffer per distinct body while the rest of the page is being fetched.
  function indexAsset(groups, address, bytes) {
    const url = new URL(address);
    const location = url.protocol === 'http:' || url.protocol === 'https:' ? url.host + url.pathname : url.href;
    if (!groups.has(location)) groups.set(location, new Map());
    const variants = groups.get(location);
    const crc = Archive.crc32(bytes);
    const key = bytes.length + '/' + crc;
    const candidates = variants.get(key) || [];
    // A matching checksum is only a filter, including for same-length responses.
    const existing = candidates.find(file => sameBytes(file.bytes, bytes));
    if (existing) return existing;
    const file = {location, bytes, crc};
    candidates.push(file);
    variants.set(key, candidates);
    return file;
  }

  function writeAssets(zip, resources, files, documentRow) {
    const paths = new Archive.Paths();
    const named = new Set();
    const priority = row => row === documentRow ? 0 : row.url.includes('?') ? 2 : 1;
    // Prefer the URL without a query for the original filename. Ties follow discovery
    // order instead of whichever response happens to finish first.
    const saved = resources.filter(row => files.has(row)).sort((a, b) => priority(a) - priority(b));
    for (const row of saved) {
      const file = files.get(row);
      if (!file.path) {
        file.path = row === documentRow ? 'original.html' : paths.forURL(row.url, row.mime, !named.has(file.location));
        zip.add(file.path, file.bytes, file.crc);
        file.bytes = null;
        named.add(file.location);
      }
      row.path = file.path;
    }
  }

  async function build(snapshot, {read = defaultRead, progress = () => {}} = {}) {
    const zip = new Archive.Zip();
    const files = new Map();
    const contentGroups = new Map();
    const records = new Map();
    const queue = [];
    const styles = [];
    const issues = new Map();
    const maps = [...snapshot.importMaps];
    const capturedAt = snapshot.capturedAt || new Date().toISOString();
    let savedBytes = 0, finished = 0;
    const documentUrl = normalized(snapshot.documentUrl || snapshot.url);
    const issue = (url, reason) => issues.set(JSON.stringify([url, reason]), {url, reason});

    function enqueue(ref, base) {
      let url;
      try { url = normalized(ref.url, base); }
      catch { issue(String(ref.url), 'Invalid URL in ' + ref.source); return; }
      if (url.startsWith('data:') || url.startsWith('about:')) return;
      const existing = records.get(url);
      if (existing) {
        if (existing.cacheOnly && !ref.cacheOnly) {
          existing.cacheOnly = false;
          if (existing.status === 'missing' && existing.attemptedCacheOnly) {
            existing.status = 'pending';
            delete existing.attemptedCacheOnly;
            delete existing.reason;
            queue.push(existing);
          }
        }
        if (existing.kind === 'asset' && ref.kind !== 'asset') existing.kind = ref.kind;
        if (existing.sources.length < 32 && !existing.sources.some(s => s.from === base && s.via === ref.source)) {
          existing.sources.push({from: base, via: ref.source});
        }
        return;
      }
      const row = {url, kind: ref.kind || 'asset', sources: [{from: base, via: ref.source}],
        cacheOnly: !!ref.cacheOnly, status: 'pending'};
      records.set(url, row);
      if (!/^(?:https?|blob):/.test(url) || records.size > maxResources) {
        row.status = 'missing';
        row.reason = records.size > maxResources ? 'Export resource limit reached' : 'Unsupported URL scheme';
      } else queue.push(row);
    }

    function scan(text, kind, base) {
      try {
        const result = Deps.scan(text, kind, base, maps);
        for (const ref of result.refs) enqueue(ref, base);
        for (const item of result.issues) issue(item.url, item.reason);
      } catch (error) { issue(base, 'Dependency scan failed: ' + error.message); }
    }

    function scanDocument(text, base, useMaps) {
      const found = Offline.htmlResources(text, base);
      if (useMaps) maps.push(...found.importMaps);
      for (const ref of found.refs) enqueue(ref, base);
      for (const item of found.inline) scan(item.text, item.kind, item.base);
    }

    for (const item of snapshot.issues) issue(item.url, item.reason);
    // Process the navigation document first so inline and external modules see
    // import maps even if the app has since removed them from the live DOM.
    enqueue({url: documentUrl, kind: 'html', source: 'navigation document'}, snapshot.url);
    const documentRow = records.get(documentUrl);

    async function collect(row) {
      try {
        if (savedBytes >= maxAssetBytes) throw new Error('256 MiB asset budget reached');
        const original = row === documentRow;
        const cacheOnly = row.cacheOnly;
        if (cacheOnly) row.attemptedCacheOnly = true;
        const result = await read(row.url, row.kind, {original, cacheOnly});
        const {bytes, mime, finalURL, retrieval} = result;
        const kind = contentKind(row.kind, mime, finalURL);
        if (kind === 'html' && row.kind !== 'html') throw new Error('Server returned an HTML document for an asset');
        if (original && mime && !/html|octet-stream/i.test(mime)) throw new Error('Document GET returned ' + mime);
        if (kind === 'js' || kind === 'css') {
          const start = new TextDecoder().decode(bytes.subarray(0, 512)).trimStart();
          if (/^<(?:!doctype\s+html|html\b|head\b|body\b)/i.test(start)) throw new Error('Received HTML instead of ' + kind.toUpperCase());
        }
        if (savedBytes + bytes.byteLength > maxAssetBytes) throw new Error('256 MiB asset budget reached');
        files.set(row, indexAsset(contentGroups, row.url, bytes));
        savedBytes += bytes.byteLength;
        Object.assign(row, {status: 'saved', kind, bytes: bytes.byteLength, mime, finalURL, retrieval});

        if (kind === 'html') {
          scanDocument(decode(bytes, mime, snapshot.charset), finalURL, original);
        } else if (kind === 'js' || kind === 'css') {
          const text = decode(bytes, mime);
          if (kind === 'css') {
            styles.push({row, text});
          }
          scan(text, kind, finalURL);
        } else if (kind === 'manifest') {
          const manifest = JSON.parse(decode(bytes, mime));
          const icons = [...(manifest.icons || []), ...(manifest.screenshots || []),
            ...(manifest.shortcuts || []).flatMap(item => item.icons || [])];
          for (const icon of icons) {
            if (typeof icon.src === 'string') enqueue({url: icon.src, kind: 'asset', source: 'manifest image'}, finalURL);
          }
        }
      } catch (error) {
        if (row.status === 'saved') issue(row.url, 'Could not inspect saved resource: ' + error.message);
        else if (row.attemptedCacheOnly && !row.cacheOnly) {
          delete row.attemptedCacheOnly;
          queue.push(row);
          return;
        } else Object.assign(row, {status: 'missing', reason: error.message || String(error)});
      }
      finished++;
      progress(finished, records.size);
    }

    if (documentRow.status === 'pending') await collect(documentRow);
    for (const ref of snapshot.refs) enqueue(ref, snapshot.base);
    for (const item of snapshot.inline) scan(item.text, item.kind, item.base);
    for (let i = queue[0] === documentRow ? 1 : 0; i < queue.length;) {
      const batch = queue.slice(i, i + 4);
      i += batch.length;
      await Promise.all(batch.map(collect));
    }
    const resources = [...records.values()];
    contentGroups.clear();
    writeAssets(zip, resources, files, documentRow);

    // Identical stylesheets can redirect to different directories. Their raw bytes share
    // one file, but each offline view must resolve relative links against its own base.
    const views = new Map();
    for (const {row, text} of styles) {
      const base = new URL(row.finalURL);
      base.search = '';
      base.hash = '';
      const candidates = views.get(row.path) || [];
      let view = candidates.find(item => item.base === base.href && item.text === text);
      if (!view) {
        const name = candidates.length ? 'style-' + (candidates.length + 1) + '.css' : 'style.css';
        view = {path: 'view/' + row.path + '/' + name, base: base.href, text};
        candidates.push(view);
        views.set(row.path, candidates);
      }
      row.viewPath = view.path;
    }
    const lookup = url => {
      const row = records.get(url);
      return row?.status === 'saved' ? row.viewPath || row.path : null;
    };
    for (const candidates of views.values()) {
      for (const view of candidates) {
        const css = Deps.rewriteCSS(view.text, view.base, url => {
          const path = lookup(url);
          return path ? relativeURL(view.path, path) : null;
        });
        zip.add(view.path, css.replace(/^@charset "[^"]+";/i, '@charset "UTF-8";'));
      }
    }

    zip.add('rendered-source.html', snapshot.html);
    zip.add('rendered.html', Offline.render(snapshot, lookup));
    const missing = resources.filter(row => row.status === 'missing');
    const report = {
      page: snapshot.url, documentUrl, title: snapshot.title, capturedAt,
      originalHTML: 'Cache-preferred GET of the navigation URL at export time. The historical response may differ.',
      limits: {maxResourceMiB: 64, maxAssetMiB: 256, maxResources},
      saved: resources.length - missing.length, missing: missing.length, resources, issues: [...issues.values()]
    };
    zip.add('report.json', JSON.stringify(report, null, 2));
    zip.add('missing.txt', [
      ...missing.map(row => row.url + ' — ' + row.reason),
      ...report.issues.map(item => item.url + ' — ' + item.reason)
    ].join('\n') || 'All discovered resources saved.\n');
    return {blob: await zip.blob(), report};
  }
  return {build};
})();
