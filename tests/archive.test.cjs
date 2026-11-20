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

test("Python zipfile reads UTF-8 filenames, binary payloads, empty files and CRCs", async () => {
  const zip = new Zip();
  zip.add("sites/été.html", "été");
  const binary = Uint8Array.from([0, 127, 128, 255]);
  zip.add("bytes.bin", binary);
  binary.fill(0);
  zip.add("empty", "");
  const script = [
    "import io, zipfile, sys",
    "z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read()))",
    "assert z.testzip() is None",
    "assert z.read('sites/été.html').decode() == 'été'",
    "assert z.read('bytes.bin') == bytes([0,127,128,255])",
    "assert z.read('empty') == b''",
  ].join("\n");
  const result = spawnSync("python3", ["-c", script], { input: Buffer.from(await zip.blob().arrayBuffer()) });
  assert.equal(result.status, 0, result.stderr.toString());
});
