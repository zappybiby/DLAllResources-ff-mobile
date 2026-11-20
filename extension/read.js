// Shared by the export tab and the content script. Read the body while the timeout
// is active, since a server can send headers long before it finishes the file.
if (!globalThis.ExportRead) globalThis.ExportRead = (() => {
  const maxBytes = 64 * 1024 * 1024;

  async function get(url, kind, request, options) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    const headers = {};
    if (kind === 'html') headers.Accept = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
    if (kind === 'css') headers.Accept = 'text/css,*/*;q=0.1';
    try {
      const response = await request(url, {...options, headers, signal: controller.signal});
      if (!response.ok) throw new Error('HTTP ' + response.status + ' ' + response.statusText);
      if (response.status === 206) throw new Error('Server returned a partial resource (HTTP 206)');
      if (Number(response.headers.get('content-length')) > maxBytes) throw new Error('Resource exceeds 64 MiB');
      const chunks = [];
      let size = 0;
      if (response.body) {
        const reader = response.body.getReader();
        for (;;) {
          const {done, value} = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > maxBytes) throw new Error('Resource exceeds 64 MiB');
          chunks.push(value);
        }
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return {bytes, mime: response.headers.get('content-type') || '', finalURL: response.url || url};
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }
  return {get};
})();
// tabs.executeScript clones the completion value when this file is injected.
void 0;
