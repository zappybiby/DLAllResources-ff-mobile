(async () => {
  const heading = document.querySelector('#heading');
  const status = document.querySelector('#status');
  const meter = document.querySelector('progress');
  try {
    const job = await browser.runtime.sendMessage({type: 'export-zip/take', key: location.hash.slice(1)});
    if (!job || job.error) throw new Error(job?.error || 'The export session has ended.');
    const {snapshot, sourceId} = job;
    document.querySelector('#title').textContent = snapshot.title || snapshot.url;
    const origin = new URL(snapshot.url).origin;

    async function read(url, kind, options) {
      const target = new URL(url);
      if (target.origin === origin) {
        const result = await browser.tabs.sendMessage(sourceId, {
          type: 'export-zip/read', id: snapshot.readerId, url, kind, ...options
        }, {frameId: 0});
        if (!result) throw new Error('The source document is no longer open');
        if (!result.error) return result;
        // A page CSP or a redirect to a CDN can block a page-context request.
        // Retry static HTTP assets without the user's session from the export tab.
        if (result.name !== 'TypeError' || options.original || options.cacheOnly || target.protocol === 'blob:') {
          throw new Error(result.error);
        }
        const fallback = await ExportRead.get(url, kind, fetch, {cache: 'force-cache', credentials: 'omit'});
        return {...fallback, retrieval: 'anonymous extension GET after page fetch failed: ' + result.error};
      }
      if (options.cacheOnly) throw new Error('Cannot access the other origin’s page cache');
      if (!['http:', 'https:'].includes(target.protocol)) throw new Error('Resource belongs to another browser context');
      const result = await ExportRead.get(url, kind, fetch, {cache: 'force-cache', credentials: 'omit'});
      return {...result, retrieval: 'cross-origin GET (force-cache, anonymous)'};
    }

    const {blob, report} = await Exporter.build(snapshot, {
      read,
      progress(done, discovered) {
        meter.max = discovered;
        meter.value = Math.min(done, discovered);
        status.textContent = 'Collecting resources · ' + Math.min(done, discovered) + ' of ' + discovered;
      }
    });
    const link = document.querySelector('#download');
    const date = report.capturedAt.substring(0, 19).replace(/:/g, '-');
    link.download = (new URL(snapshot.url).hostname || 'page') + '-' + date + '.zip';
    link.href = URL.createObjectURL(blob);
    link.hidden = false;
    heading.textContent = 'ZIP ready';
    status.textContent = report.saved + ' saved · ' + report.missing + ' missing' +
      (report.issues.length ? ' · ' + report.issues.length + ' capture notes' : '');
    link.click();
    // The link remains valid if Firefox asks for confirmation or the user retries.
    // Its document owns the Blob URL and releases it when the tab closes.
  } catch (error) {
    heading.textContent = 'Export interrupted';
    status.textContent = error.message || String(error);
  } finally {
    meter.hidden = true;
  }
})();
