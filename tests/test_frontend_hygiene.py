"""
Frontend hygiene checks (grep based, no browser needed).
They keep the redesign rules from regressing while the classic scripts are migrated step by step.
"""

import re
import unittest
from pathlib import Path

WEB = Path(__file__).resolve().parent.parent / "web"
# ES modules written for the redesign: built with DOM helpers, never innerHTML or inline styles
MODULE_DIRS = [WEB / "js" / "core", WEB / "js" / "components", WEB / "js" / "features"]

# Inline style="..." attributes still in index.html and the classic scripts. Lower this as views are
# rebuilt; it must never go up.
INLINE_STYLE_BASELINE = 538


def _ui_sources():
    files = [WEB / "index.html", WEB / "app.js", *sorted((WEB / "js").rglob("*.js"))]
    return [(p, p.read_text(encoding="utf-8")) for p in files]


class TestFrontendHygiene(unittest.TestCase):

    def test_no_native_confirm_or_prompt(self):
        pattern = re.compile(r"(?<![\w.])(?:window\.)?(confirm|prompt|alert)\(")
        offenders = [f"{p.name}:{text.count(chr(10), 0, m.start()) + 1}"
                     for p, text in _ui_sources() if p.suffix == ".js"
                     for m in pattern.finditer(text)]
        self.assertEqual(offenders, [], "use window.confirmDialog / window.promptDialog instead")

    def test_no_off_palette_cyan(self):
        pattern = re.compile(r"rgba\(\s*0\s*,\s*24[0-9]\s*,\s*25[0-9]")
        offenders = [p.name for p, text in _ui_sources() if pattern.search(text)]
        offenders += [p.name for p in WEB.joinpath("css").glob("*.css") if pattern.search(p.read_text(encoding="utf-8"))]
        self.assertEqual(offenders, [], "use rgba(var(--accent-rgb), a)")

    def test_inline_styles_do_not_grow(self):
        count = sum(text.count('style="') for _, text in _ui_sources())
        self.assertLessEqual(count, INLINE_STYLE_BASELINE, "move new styling into CSS classes")

    def test_redesign_modules_build_dom_safely(self):
        for path in (p for d in MODULE_DIRS for p in d.glob("*.js")):
            text = path.read_text(encoding="utf-8")
            self.assertNotRegex(text, r"\.innerHTML\s*[+]?=", path.name)
            self.assertNotIn('style="', text, path.name)

    def test_no_calls_to_removed_api_shims(self):
        # window.api is the core client now; the old "window.api ? window.api.x() : fetch()" guard would crash
        offenders = [p.name for p, text in _ui_sources() if re.search(r"window\.api\s*\?", text)]
        self.assertEqual(offenders, [])

    def test_scripts_run_in_document_order(self):
        # Classic scripts must be deferred so they run after the core module that defines window.api
        html = (WEB / "index.html").read_text(encoding="utf-8")
        tags = re.findall(r"<script\b[^>]*\bsrc=[^>]*>", html)
        self.assertTrue(tags)
        self.assertIn('type="module"', tags[0])
        for tag in tags[1:]:
            self.assertRegex(tag, r"\bdefer\b", tag)

    def test_body_is_not_zoomed(self):
        theme = (WEB / "css" / "theme.css").read_text(encoding="utf-8")
        body_rule = re.search(r"\bbody\s*\{[^}]*\}", theme).group(0)
        self.assertNotIn("zoom", body_rule)


if __name__ == "__main__":
    unittest.main()
