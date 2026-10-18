"""Trace real Mermaid output in headless Chromium with the plugin's extractor.

Regenerates the drawing fixtures the tests use, from the same code path the
plugin runs in Obsidian (svgextract.ts), against a real Mermaid build.

    npm pack mermaid@11 && tar xzf mermaid-*.tgz            # → package/dist/mermaid.min.js
    npx esbuild src/ink/svgextract.ts --bundle --format=iife \
        --global-name=SvgExtract --outfile=scripts/mermaid-trace/extract.js
    python3 scripts/mermaid-trace/trace.py package/dist/mermaid.min.js out/

Needs Python Playwright with a Chromium build (PLAYWRIGHT_BROWSERS_PATH).
The theme directive is read from src/ink/mermaidtheme.ts's compiled output
passed in THEME (or the default below, kept in sync by hand).
"""
import json, os, sys
from pathlib import Path
from playwright.sync_api import sync_playwright

here = Path(__file__).parent
mermaid_js, out_dir = sys.argv[1], Path(sys.argv[2])
out_dir.mkdir(parents=True, exist_ok=True)
diagrams = json.loads((here / "diagrams.json").read_text())
theme = os.environ.get("THEME") or (here / "theme.txt").read_text()

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page()
    page.set_content("<html><body></body></html>")
    page.add_script_tag(content=Path(mermaid_js).read_text())
    page.add_script_tag(content=(here / "extract.js").read_text())
    page.evaluate("mermaid.initialize({startOnLoad:false})")
    for name, code in diagrams.items():
        drawing = page.evaluate(
            """async ([id, code]) => {
                const { svg } = await mermaid.render(id, code);
                const host = document.createElement('div');
                host.style.cssText = 'position:absolute;left:-100000px;top:0';
                document.body.appendChild(host);
                const parsed = new DOMParser().parseFromString(svg, 'text/html').body.querySelector('svg');
                const el = host.appendChild(document.importNode(parsed, true));
                const vb = el.viewBox.baseVal;
                el.setAttribute('width', vb.width); el.setAttribute('height', vb.height);
                const d = SvgExtract.extractDrawing(el); host.remove(); return d;
            }""",
            [f"t-{name}", theme + code],
        )
        (out_dir / f"{name}.json").write_text(json.dumps(drawing))
        print(name, len(drawing["paths"]), "paths", len(drawing["fills"]), "fills", len(drawing["labels"]), "labels")
    browser.close()
