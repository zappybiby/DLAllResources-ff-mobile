"""Run the export pipeline against a live module app and open the resulting file offline.

Default mode uses Python Playwright and Chromium. Set CHROMIUM_PATH to select the binary.
For a DOM and Firefox messaging simulation, pass --dom-module /path/to/worker.mjs
using the standalone worker.js ES module from WebReflection/linkedom (with .mjs suffix).
"""
import argparse
import base64
import io
import json
import os
from pathlib import Path
import re
import shutil
from collections import Counter
import subprocess
import tempfile
from html.parser import HTMLParser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
from urllib.parse import unquote, urlsplit
from zipfile import ZipFile

EXTENSION = Path(__file__).resolve().parents[1] / "extension"
ORIGINAL = """<!doctype html>
<html><head><meta charset="utf-8"><title>Order review</title>
<base href="/app/"><link rel="stylesheet" href="styles/main.css">
<script type="module" src="entry.js"></script></head>
<body><button id="orders">Open table</button><main></main></body></html>"""
PRELOADS = ["table.js", "editor.js", *[f"chunk-{i:02}.js" for i in range(25)]]
ENTRY = """
document.querySelector('#orders').onclick = async () => {
  const names = PRELOAD_LIST;
  for (const name of names) {
    const link = document.createElement('link');
    link.rel = 'modulepreload';
    link.href = 'chunks/' + name;
    document.head.append(link);
  }
  const {show} = await import('./chunks/table.js');
  show();
};
export const extras = () => import('./later/data.js');
""".replace("PRELOAD_LIST", json.dumps(PRELOADS))
TABLE = """
import {editor} from './editor.js';
export function show() {
  document.querySelector('main').innerHTML =
    '<table><tr><td>Order 47</td></tr></table>' + editor;
  document.querySelector('dialog').showModal();
}
"""
EDITOR = """
export const editor = `<dialog><label>Item<input id="item" value="original"></label>
<textarea id="notes">Old note</textarea>
<select id="priority"><option>Routine</option><option>Urgent</option></select>
<input type="checkbox" id="ready"></dialog>`;
"""
FIXTURES = {
    "/orders": ("text/html", ORIGINAL),
    "/runner": ("text/html", "<!doctype html><title>Test</title>"),
    "/app/entry.js": ("text/javascript", ENTRY),
    "/app/chunks/table.js": ("text/javascript", TABLE),
    "/app/chunks/editor.js": ("text/javascript", EDITOR),
    "/app/later/data.js": ("text/javascript", "export { default } from './labels.js';"),
    "/app/later/labels.js": ("text/javascript", 'export default "Later";'),
    "/app/styles/main.css": ("text/css", '@import "./theme/colors.css";'),
    "/app/styles/theme/colors.css": (
        "text/css",
        'table { color: rgb(1, 70, 130); background: url("../../media/grid.svg") }'
        ' body { cursor: url("../../unavailable.cur"), auto }',
    ),
    "/app/media/grid.svg": ("image/svg+xml", '<svg xmlns="http://www.w3.org/2000/svg"/>'),
}
for name in PRELOADS[2:]:
    FIXTURES["/app/chunks/" + name] = ("text/javascript", f'export default "{name}";')


class Fixture(BaseHTTPRequestHandler):
    def do_GET(self):
        path = urlsplit(self.path).path
        self.server.calls[("GET", path)] += 1
        if path == "/app/later/labels.js" and "fixture-session=active" not in self.headers.get("Cookie", ""):
            self.send_error(403)
            return
        if path not in FIXTURES:
            self.send_error(404)
            return
        content_type, content = FIXTURES[path]
        data = content.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-type", content_type + "; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        if path == "/orders":
            self.send_header("Set-Cookie", "fixture-session=active; Path=/; HttpOnly; SameSite=Lax")
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        self.server.calls[("POST", self.path)] += 1
        self.send_response(204)
        self.end_headers()

    def log_message(self, *args):
        pass


def export(browser, base):
    page = browser.new_page()
    page.goto(base + "/orders")
    page.locator("#orders").click()
    page.locator("#item").fill("Changed after load")
    page.locator("#notes").fill("ETA 13:45")
    page.locator("#priority").select_option(label="Urgent")
    page.locator("#ready").check()
    page.wait_for_load_state("networkidle")
    assert page.locator('link[rel="modulepreload"]').count() == 27
    page.evaluate("""async () => {
      history.pushState({}, '', '/app/orders/47');
      performance.clearResourceTimings();
      await fetch('/api/overview', {method:'POST'});
    }""")
    assert not page.evaluate("""() => performance.getEntriesByType('resource').some(
        item => item.name.includes('/chunks/'))""")

    snapshot = page.evaluate((EXTENSION / "snapshot.js").read_text())
    assert page.locator("dialog").evaluate("el => el.matches(':modal')")
    assert page.locator("#notes").input_value() == "ETA 13:45"
    runner = page.context.new_page()
    runner.goto(base + "/runner")
    scripts = re.findall(r'<script[^>]+src="([^"]+)"', (EXTENSION / "export.html").read_text())
    for name in scripts:
        if Path(name).name != "ui.js":
            runner.add_script_tag(content=(EXTENSION / name).read_text())
    payload = runner.evaluate("""async snapshot => {
      const {blob} = await Exporter.build(snapshot);
      const data = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
      });
      return data.split(',')[1];
    }""", snapshot)
    runner.close()
    page.close()
    return base64.b64decode(payload)


def inspect_zip(browser, payload, base):
    with ZipFile(io.BytesIO(payload)) as archive, tempfile.TemporaryDirectory() as tmp:
        assert archive.testzip() is None
        assert archive.read("original.html") == ORIGINAL.encode("utf-8")
        assert len(archive.namelist()) == len(set(archive.namelist()))
        snapshot = archive.read("rendered-source.html").decode()
        assert "Order 47" in snapshot and "Changed after load" in snapshot
        report = json.loads(archive.read("report.json"))
        by_url = {resource["url"]: resource for resource in report["resources"]}
        for path, (_, data) in FIXTURES.items():
            if not path.startswith("/app/"):
                continue
            entry = by_url.get(base + path)
            assert entry and entry["status"] == "saved", (path, entry)
            assert archive.read(entry["path"]) == data.encode(), path
        missing = by_url.get(base + "/app/unavailable.cur")
        assert missing and missing["status"] == "missing" and missing["reason"], missing
        archive.extractall(tmp)

        if browser is None:
            # HTMLParser handles the void elements and boolean attributes in serialized HTML.
            class Preview(HTMLParser):
                def __init__(self):
                    super().__init__()
                    self.elements = []

                def handle_starttag(self, tag, attrs):
                    self.elements.append((tag, dict(attrs)))

            preview = Preview()
            html = archive.read("rendered.html").decode()
            preview.feed(html)
            assert any(tag == "dialog" and "open" in attrs for tag, attrs in preview.elements)
            assert any(a.get("id") == "item" and a.get("value") == "Changed after load"
                       for _, a in preview.elements)
            assert any(a.get("id") == "ready" and "checked" in a for _, a in preview.elements)
            assert re.search(r"<textarea[^>]*>ETA 13:45</textarea>", html)
            assert re.search(r"<option[^>]*selected[^>]*>Urgent</option>", html)
            assert "Order 47" in html
            css_path = next(attrs["href"] for tag, attrs in preview.elements
                            if tag == "link" and attrs.get("rel") == "stylesheet")
            main_css = Path(tmp) / unquote(css_path)
            assert main_css.is_file(), css_path
            css_url = r"""url\(\s*['"]?([^)'"]+)['"]?\s*\)"""
            import_match = re.search(r"""@import\s+(?:['"]([^'"]+)['"]|""" + css_url + ")", main_css.read_text())
            assert import_match, main_css.read_text()
            import_path = next(group for group in import_match.groups() if group)
            imported_css = main_css.parent / unquote(import_path)
            asset_path = re.search(css_url, imported_css.read_text()).group(1)
            assert (imported_css.parent / unquote(asset_path)).read_bytes() == FIXTURES["/app/media/grid.svg"][1].encode()
            return

        preview = browser.new_page()
        attempted_network = []
        preview.on("request", lambda req: attempted_network.append(req.url)
                   if req.url.startswith(("https:", "http:")) else None)
        preview.goto((Path(tmp) / "rendered.html").as_uri())
        assert preview.locator("dialog").is_visible()
        assert preview.locator("dialog").evaluate("el => el.matches(':modal')")
        assert preview.locator("td").inner_text() == "Order 47"
        assert preview.locator("#item").input_value() == "Changed after load"
        assert preview.locator("#notes").input_value() == "ETA 13:45"
        assert preview.locator("#priority").input_value() == "Urgent"
        assert preview.locator("#ready").is_checked()
        assert preview.locator("table").evaluate("el => getComputedStyle(el).color") == "rgb(1, 70, 130)"
        assert not attempted_network, attempted_network
        preview.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dom-module", help="Use the standalone linkedom worker module instead of Playwright")
    args = parser.parse_args()
    server = ThreadingHTTPServer(("127.0.0.1", 0), Fixture)
    server.calls = Counter()
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{server.server_port}"
    try:
        if args.dom_module:
            result = subprocess.run(
                ["node", str(Path(__file__).with_name("integration_dom.mjs")), args.dom_module],
                input=json.dumps({"files": FIXTURES, "origin": base}).encode(), stdout=subprocess.PIPE,
                check=True,
            )
            inspect_zip(None, result.stdout, base)
        else:
            from playwright.sync_api import sync_playwright
            with sync_playwright() as playwright:
                executable = os.environ.get("CHROMIUM_PATH") or shutil.which("chromium")
                browser = playwright.chromium.launch(executable_path=executable, headless=True)
                print("Chromium", browser.version)
                inspect_zip(browser, export(browser, base), base)
                assert server.calls[("POST", "/api/overview")] == 1
                browser.close()
        assert server.calls[("GET", "/api/overview")] == 0
    finally:
        server.shutdown()
        server.server_close()
        thread.join()
    print("PASS: 27 modulepreloads, recursive JS/CSS, original bytes, missing resource, "
          "no API replay, and offline form/dialog/styles")


if __name__ == "__main__":
    main()
