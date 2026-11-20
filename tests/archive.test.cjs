"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
require("../extension/archive.js");
const { Paths, Zip } = globalThis.Archive;

test("original path, fragment aliases, query variants and host isolation", () => {
  const paths = new Paths();
  const url = "https://demo.test/build/assets/table.js";
  assert.equal(paths.forURL(url), "assets/demo.test/build/assets/table.js");
  assert.equal(paths.forURL(url + "#test"), paths.forURL(url));
  assert.match(paths.forURL(url + "?v=1"), /table~[0-9a-f]+\.js$/);
  assert.notEqual(paths.forURL(url + "?v=2"), paths.forURL(url + "?v=1"));
  assert.notEqual(paths.forURL(url), paths.forURL(url.replace("https", "http")));
  assert.equal(paths.forURL("https://demo.test/", "text/html"), "assets/demo.test/index.html");
});

test("case, percent encoding, long names, devices and file/directory conflicts", () => {
  const paths = new Paths();
  const zip = new Zip();
  const urls = ["imgs", "imgs/logo.svg", "imgs/Logo.svg", "imgs/%6cogo.svg",
    "%2fetc%5cfile", "NUl.txt", "x//y", "x/_/y", "a.", "a", "%2F",
    "😎".repeat(100) + ".svg", "x/y", "%00.txt", "．．／etc", "ＣＯＮ", "file?x=.png"];
  const names = urls.map(url => paths.forURL("https://demo.test/" + url));
  for (const name of names) {
    zip.add(name, "");
    assert.ok(name.split("/").every(part => Buffer.byteLength(part) <= 255));
  }
});

test("custom ZIP entries reject conflicting and unsafe names", () => {
  for (const path of ["../out", "/evil", "x/../a", "x//a", "C:/a", "x\\a", "CON.js", "．．／etc", "ＮＵＬ.txt"]) {
    assert.throws(() => new Zip().add(path, "x"));
  }
  const zip = new Zip();
  zip.add("inside/page.html", "");
  assert.throws(() => zip.add("InsIdE", "x"));
  assert.throws(() => zip.add("inside/page.html/child", "x"));
  assert.throws(() => zip.add("inside/PAGE.HTML", "x"));
});

test("Python zipfile validates mixed DEFLATE and stored entries, offsets and CRCs", async () => {
  const zip = new Zip();
  zip.add("sites/été.html", "été".repeat(10000));
  const binary = Uint8Array.from([0, 127, 128, 255]);
  zip.add("bytes.bin", binary);
  binary.fill(0);
  zip.add("empty", "");
  zip.add("css/é.css", ".table { color: red; }".repeat(10000));
  const first = zip.blob();
  zip.add("later", "only in the second snapshot");
  const second = zip.blob();
  const script = [
    "import io, struct, zipfile, sys",
    "raw=sys.stdin.buffer.read()",
    "z=zipfile.ZipFile(io.BytesIO(raw))",
    "assert ('later' in z.namelist()) == (sys.argv[1] == 'second')",
    "for info in z.infolist():",
    "    offset=info.header_offset",
    "    assert raw[offset:offset+4] == b'PK\\x03\\x04'",
    "    assert struct.unpack_from('<H', raw, offset+8)[0] == info.compress_type",
    "    assert struct.unpack_from('<III', raw, offset+14) == (info.CRC, info.compress_size, info.file_size)",
    "assert z.testzip() is None",
    "assert z.read('sites/été.html').decode() == 'été'*10000",
    "assert z.read('css/é.css').decode() == '.table { color: red; }'*10000",
    "for name in ['sites/été.html', 'css/é.css']:",
    "    info=z.getinfo(name)",
    "    assert info.compress_type == zipfile.ZIP_DEFLATED and info.compress_size < info.file_size//10",
    "assert z.getinfo('empty').compress_type == z.getinfo('bytes.bin').compress_type == zipfile.ZIP_STORED",
    "assert z.read('bytes.bin') == bytes([0,127,128,255])",
    "assert z.read('empty') == b''",
  ].join("\n");
  for (const [name, blob] of [["first", await first], ["second", await second]]) {
    const result = spawnSync("python3", ["-c", script, name], { input: Buffer.from(await blob.arrayBuffer()) });
    assert.equal(result.status, 0, result.stderr.toString());
  }
});
