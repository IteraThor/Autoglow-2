"""
The browser copy of the Flow Matrix looks (web/js/features/flow-looks.js) must draw exactly what the
light strip shows (core/effects/flow). Node renders the same cases; every channel may differ by at most 1.
"""

import itertools
import json
import os
import shutil
import subprocess
import tempfile
import unittest

from core.effects.flow import FLOW_EFFECTS, FLOW_TRANSITIONS, blend_flow, normalize_options, render_flow_frame
from core.models import EffectConfig

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODULE = os.path.join(ROOT, "web", "js", "features", "flow-looks.js")


def cases():
    out = []
    for anim, spec in FLOW_EFFECTS.items():
        keys = list(spec["options"])
        for values in itertools.product(*(spec["options"][k][1] for k in keys)):
            opts = dict(zip(keys, values, strict=True))
            for duration, speed, reverse, count in ((0.0, 1.0, False, 45), (2.0, 1.7, True, 300), (1.0, 0.25, False, 7)):
                out.append({
                    "animation": anim, "color_primary": [250, 120, 10], "color_secondary": [5, 20, 60],
                    "duration": duration, "speed": speed, "reverse": reverse, "options": opts,
                    "count": count, "times": [0.0, 0.03, 0.41, 1.234, 2.5, 9.87],
                })
    return out


@unittest.skipUnless(shutil.which("node"), "node is not installed")
class TestBrowserLooksMatchTheStrip(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.cases = cases()
        cls.blends = [
            {"style": s, "count": n, "factor": f, "accent": [0, 255, 0] if s == "flash" else None}
            for s in FLOW_TRANSITIONS for n in (1, 45, 300) for f in (0.0, 0.1, 0.37, 0.5, 0.8, 1.0)
        ]
        tmp = tempfile.mkdtemp()
        try:
            script = os.path.join(tmp, "run.mjs")
            with open(script, "w") as f:
                f.write(
                    f"import {{ renderFlowFrame, blendFlow }} from {json.dumps('file://' + MODULE)};\n"
                    f"const cases = {json.dumps(cls.cases)};\n"
                    f"const blends = {json.dumps(cls.blends)};\n"
                    "const a = n => Array.from({length: n * 3}, (_, i) => (i * 37) % 256);\n"
                    "const b = n => Array.from({length: n * 3}, (_, i) => (i * 91 + 13) % 256);\n"
                    "const frames = cases.map(c => c.times.map(t => Array.from(renderFlowFrame(c, t, c.count))));\n"
                    "const mixed = blends.map(x => Array.from(blendFlow(a(x.count), b(x.count), x.factor, x.style, x.accent)));\n"
                    "process.stdout.write(JSON.stringify({frames, mixed}));\n"
                )
            res = subprocess.run(["node", script], capture_output=True, text=True, timeout=120)
            if res.returncode != 0:
                raise RuntimeError(res.stderr)
            cls.js = json.loads(res.stdout)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def assertClose(self, py, js, label):
        self.assertEqual(len(py), len(js), label)
        worst = max((abs(p - j) for p, j in zip(py, js, strict=True)), default=0)
        self.assertLessEqual(worst, 1, label)

    def test_every_look_matches(self):
        for case, frames in zip(self.cases, self.js["frames"], strict=True):
            eff = EffectConfig.from_dict({**case, "options": normalize_options(case["animation"], case["options"])})
            for t, js in zip(case["times"], frames, strict=True):
                py = list(render_flow_frame(eff, t, case["count"]))
                self.assertClose(py, js, f"{case['animation']} {case['options']} d={case['duration']} n={case['count']} t={t}")

    def test_every_transition_matches(self):
        for blend, js in zip(self.blends, self.js["mixed"], strict=True):
            n = blend["count"]
            a = bytes((i * 37) % 256 for i in range(n * 3))
            b = bytes((i * 91 + 13) % 256 for i in range(n * 3))
            accent = tuple(blend["accent"]) if blend["accent"] else None
            py = list(blend_flow(a, b, blend["factor"], blend["style"], accent))
            self.assertClose(py, js, f"{blend['style']} n={n} f={blend['factor']}")


if __name__ == "__main__":
    unittest.main()
