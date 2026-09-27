"""Offline integration check for release tags and tracked-source diffs."""

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "collect.py"


class CollectTests(unittest.TestCase):
    def test_default_baseline_and_source_diff_ignore_git_metadata(self):
        with tempfile.TemporaryDirectory() as scratch:
            root = Path(scratch)
            repo = root / "upstream"
            repo.mkdir()

            def git(*args: str) -> None:
                subprocess.run(["git", *args], cwd=repo, check=True, capture_output=True, text=True)

            git("init", "-q")
            git("config", "user.email", "review@example.invalid")
            git("config", "user.name", "Review")
            (repo / "package.json").write_text(json.dumps({
                "name": "fixture",
                "dsh": {"compatibility": {"dshReleases": {"0.1.7-rc.2": "compatible"}}},
            }), encoding="utf-8")
            (repo / "src").mkdir()
            (repo / "src" / "app.ts").write_text("old\n", encoding="utf-8")
            git("add", ".")
            git("commit", "-qm", "baseline")
            git("tag", "dsh-v0.1.7-rc.2")
            (repo / "src" / "app.ts").write_text("new\n", encoding="utf-8")
            git("add", ".")
            git("commit", "-qm", "target")
            git("tag", "dsh-v0.1.7-rc.3")

            for tag, expected in (
                ("dsh-v0.1.7-rc.2", ""),
                ("dsh-v0.1.7-rc.3", "M\tsrc/app.ts\n"),
            ):
                output = root / tag
                result = subprocess.run(
                    [sys.executable, str(SCRIPT), "--target", tag, "--repo", repo.as_uri(), "--out", str(output)],
                    cwd=repo, capture_output=True, text=True,
                )
                self.assertEqual(result.returncode, 0, result.stderr)
                manifest = json.loads((output / "manifest.json").read_text(encoding="utf-8"))
                self.assertEqual(manifest["baseline"], "dsh-v0.1.7-rc.2")
                self.assertEqual((output / "changed-files.txt").read_text(encoding="utf-8"), expected)
                diff = (output / "diff.txt").read_text(encoding="utf-8")
                self.assertNotIn(".git/", diff)
                self.assertEqual("src/app.ts" in diff, bool(expected))


if __name__ == "__main__":
    unittest.main()
