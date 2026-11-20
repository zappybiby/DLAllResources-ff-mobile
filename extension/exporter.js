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

  async function build(snapshot, {read = defaultRead, progress = () => {}} = {}) {
    const zip = new Archive.Zip();
    const paths = new Archive.Paths();
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
        const path = original ? 'original.html' : paths.forURL(row.url, mime);
        zip.add(path, bytes);
        savedBytes += bytes.byteLength;
        Object.assign(row, {status: 'saved', path, kind, bytes: bytes.byteLength, mime, finalURL, retrieval});

        if (kind === 'html') {
          scanDocument(decode(bytes, mime, snapshot.charset), finalURL, original);
        } else if (kind === 'js' || kind === 'css') {
          const text = decode(bytes, mime);
          if (kind === 'css') {
            row.viewPath = 'view/' + path + '/style.css';
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
    const lookup = url => {
      const row = records.get(url);
      return row?.status === 'saved' ? row.viewPath || row.path : null;
    };
    for (const {row, text} of styles) {
      const css = Deps.rewriteCSS(text, row.finalURL, url => {
        const path = lookup(url);
        return path ? relativeURL(row.viewPath, path) : null;
      });
      zip.add(row.viewPath, css.replace(/^@charset "[^"]+";/i, '@charset "UTF-8";'));
    }

    zip.add('rendered-source.html', snapshot.html);
    zip.add('rendered.html', Offline.render(snapshot, lookup));
    const resources = [...records.values()];
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
    return {blob: zip.blob(), report};
  }
  return {build};
})();
