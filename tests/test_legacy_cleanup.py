"""
Tests for removing files that older AutoGlow versions shipped (left behind by unpacking over an old install).
"""

import os
import shutil
import tempfile
import unittest

from core import legacy_cleanup


class TestLegacyCleanup(unittest.TestCase):

    def setUp(self):
        self.root = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def _touch(self, rel):
        path = os.path.join(self.root, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as f:
            f.write("old")
        return path

    def test_removes_only_listed_leftovers(self):
        stale = self._touch("routes/system_routes.py")
        kept = self._touch("routes/hub_routes.py")
        user_data = self._touch("config.json")
        removed = legacy_cleanup.remove_legacy_files(self.root)
        self.assertEqual(removed, ["routes/system_routes.py"])
        self.assertFalse(os.path.exists(stale))
        self.assertTrue(os.path.exists(kept))
        self.assertTrue(os.path.exists(user_data))

    def test_clean_install_is_a_no_op(self):
        self.assertEqual(legacy_cleanup.remove_legacy_files(self.root), [])

    def test_no_listed_file_is_part_of_this_version(self):
        for rel in legacy_cleanup.REMOVED_FILES:
            self.assertFalse(os.path.exists(os.path.join(legacy_cleanup.ROOT, rel)), rel)

    def test_user_data_is_never_listed(self):
        for rel in legacy_cleanup.REMOVED_FILES:
            self.assertFalse(rel.endswith(".json") or rel.startswith(("presets/", "backups/")), rel)


if __name__ == "__main__":
    unittest.main()
