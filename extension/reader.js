(() => {
  if (globalThis.__exportZipReaderId) return;
  const id = Array.from(crypto.getRandomValues(new Uint32Array(4))).join('-');
  globalThis.__exportZipReaderId = id;
  browser.runtime.onMessage.addListener(message => {
    if (message.type !== 'export-zip/read' || message.id !== id) return;
    return read(message).catch(error => ({error: error.message, name: error.name}));
  });

  async function read({url, kind, original, cacheOnly}) {
    const target = new URL(url);
    if (!['http:', 'https:', 'blob:'].includes(target.protocol) || target.origin !== location.origin) {
      throw new Error('Resource does not belong to this page origin');
    }
    const page = typeof content !== 'undefined' && typeof content.fetch === 'function' ? content : window;
    const request = page.fetch.bind(page);
    const options = {mode: 'same-origin', credentials: 'same-origin', cache: 'force-cache'};
    if (original || cacheOnly) {
      try {
        const result = await ExportRead.get(url, kind, request, {...options, cache: 'only-if-cached'});
        return {...result, retrieval: 'page cache request (only-if-cached)'};
      } catch (error) {
        if (cacheOnly) throw new Error('No cached response available: ' + error.message);
        // A GET may still recover the navigation document if the cache has no usable copy.
      }
    }
    const result = await ExportRead.get(url, kind, request, {...options, mode: 'cors'});
    return {...result, retrieval: 'page GET (force-cache)'};
  }
})();
