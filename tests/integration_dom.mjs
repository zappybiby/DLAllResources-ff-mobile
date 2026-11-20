// Headless DOM fallback for environments without a browser executable.
// integration.py supplies the same fixture, including its real module entry.
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import vm from 'node:vm';
import {json} from 'node:stream/consumers';

const {parseHTML, DOMParser, Node, Element} = await import(process.argv[2]);
const extension = fileURLToPath(new URL('../extension/', import.meta.url));
const {files, origin} = await json(process.stdin);
const {document} = parseHTML(files['/orders'][1]);
const navigationURL = origin + '/orders';
const url = origin + '/app/orders/47';
const base = origin + '/app/';
Object.assign(globalThis, {document, DOMParser, location: new URL(url)});
globalThis.XMLSerializer = class {
  serializeToString(node) { return node.toString(); }
};
Object.defineProperty(Node.prototype, 'baseURI', {get() { return base; }});
Object.defineProperty(document, 'baseURI', {value: base});
Object.defineProperty(document, 'URL', {value: url});
Object.defineProperty(globalThis, 'performance', {value: {
  now: () => Date.now(),
  markResourceTiming() {},
  getEntriesByType(type) {
    if (type === 'navigation') return [{name: navigationURL}];
    // Model an already-open tab after its module timing entries were evicted.
    return type === 'resource' ? [{initiatorType: 'fetch', name: origin + '/api/overview'}] : [];
  }
}});
const matches = Element.prototype.matches;
Element.prototype.matches = function(selector) {
  if (selector === ':modal') return this.isModal === true;
  return matches.call(this, selector);
};
const dir = await mkdtemp(join(tmpdir(), 'page-export-test-'));
try {
  await writeFile(join(dir, 'package.json'), '{"type":"module"}');
  for (const [path, [, data]] of Object.entries(files)) {
    if (path.endsWith('.js')) {
      const file = join(dir, path);
      await mkdir(dirname(file), {recursive: true});
      await writeFile(file, data);
    }
  }
  // linkedom exposes attributes and tree operations but omits showModal().
  const proto = Object.getPrototypeOf(document.createElement('dialog'));
  proto.showModal = function() {
    this.open = true;
    this.isModal = true;
    this.setAttribute('open', '');
  };
  await import(pathToFileURL(join(dir, 'app', 'entry.js')));
  await document.querySelector('#orders').onclick();
  const prop = (el, key, value) => Object.defineProperty(el, key, {value});
  prop(document.querySelector('#item'), 'value', 'Changed after load');
  prop(document.querySelector('#notes'), 'value', 'ETA 13:45');
  for (const opt of document.querySelectorAll('option')) prop(opt, 'selected', opt.textContent === 'Urgent');
  prop(document.querySelector('#ready'), 'checked', true);
  assert.equal(document.querySelectorAll('link[rel=modulepreload]').length, 27);
  // Emulate Firefox's messaging APIs with separate globals for each extension context.
  // All script results and messages cross a structured-clone boundary.
  const makeContext = extra => vm.createContext({
    crypto, URL, TextEncoder, TextDecoder, Blob, Response, CompressionStream, AbortController, setTimeout, clearTimeout,
    Uint8Array, DOMParser, XMLSerializer, console, ...extra
  });
  const listeners = {};
  const tabId = 17;
  const viewer = 'moz-extension://fixture/export.html';
  const register = key => ({addListener(fn) { listeners[key] = fn; }});
  const run = async (context, file) => vm.runInContext(
    await readFile(join(extension, file), 'utf8'), context, {filename: file}
  );
  // Substitute the browser's cookie jar. Cached navigation replay may miss, which must
  // cause the normal same-origin, credentialed fallback in the original tab.
  const pageFetch = (addr, options) => {
    assert.equal(new URL(addr).origin, origin);
    assert.equal(options.credentials, 'same-origin');
    assert.equal(options.mode, options.cache === 'only-if-cached' ? 'same-origin' : 'cors');
    if (options.cache === 'only-if-cached') return Promise.reject(Error('cache miss'));
    return fetch(addr, {...options, headers: {...options.headers, Cookie: 'fixture-session=active'}});
  };
  const source = makeContext({
    document, performance, location: new URL(url), window: {fetch: pageFetch},
    browser: {runtime: {onMessage: register('reader')}}
  });
  let jobURL, snapshot;
  const background = makeContext({
    setTimeout: (...args) => setTimeout(...args).unref(),
    browser: {
      browserAction: {onClicked: register('click')},
      runtime: {getURL: () => viewer, onMessage: register('take')},
      tabs: {
        async executeScript(id, opts) {
          assert.equal(id, tabId);
          const result = structuredClone(await run(source, opts.file));
          if (opts.file === 'snapshot.js') snapshot = result;
          return [result];
        },
        async create({url}) { jobURL = url; }
      }
    }
  });
  await run(background, 'background.js');
  assert(!snapshot && !jobURL);
  await listeners.click({id: tabId, url});
  assert(snapshot?.readerId, 'Page capture failed in the browser action handler');
  assert.equal(snapshot.refs.filter(r => r.source.includes('modulepreload')).length, 27);
  assert.equal(document.querySelector('#item').getAttribute('value'), 'original');
  assert.equal(document.querySelector('#notes').textContent, 'Old note');
  assert(jobURL.startsWith(viewer + '#'));
  const exportDoc = parseHTML(await readFile(join(extension, 'export.html'), 'utf8')).document;
  let downloadURL;
  exportDoc.querySelector('#download').click = function () {
    assert(this.download.endsWith('.zip'));
    assert(!downloadURL, 'Download should start once');
    downloadURL = this.href;
  };
  const ui = makeContext({
    document: exportDoc, location: new URL(jobURL), fetch,
    browser: {
      runtime: {async sendMessage(msg) {
        return structuredClone(await listeners.take(structuredClone(msg), {url:jobURL}));
      }},
      tabs: {async sendMessage(id, msg, opts) {
        assert.equal(id, tabId);
        assert.equal(opts.frameId, 0);
        return structuredClone(await listeners.reader(structuredClone(msg)));
      }}
    }
  });
  for (const script of exportDoc.querySelectorAll('script[src]')) {
    await run(ui, script.getAttribute('src'));
  }
  assert(downloadURL, exportDoc.querySelector('#status').textContent);
  const download = await fetch(downloadURL);
  process.stdout.write(Buffer.from(await download.arrayBuffer()));
  URL.revokeObjectURL(downloadURL);
} finally {
  await rm(dir, {recursive: true, force: true});
}
