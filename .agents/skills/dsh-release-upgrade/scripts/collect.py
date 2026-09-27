#!/usr/bin/env python3
"""Collect a public DSH release delta for the plugin compatibility audit.

The script intentionally does not edit the plugin checkout. It clones two public
DSH tags, records the GitHub release metadata when available, and writes a small
machine-readable inventory of changed packages/imports/high-risk paths.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

DEFAULT_REPO = "https://github.com/deepseek-ai/deepseek-harness.git"
RISK_ROOTS = (
    "packages/llm/llm/",
    "packages/settings/",
    "packages/credentials/",
    "packages/interaction/",
    "packages/tools/",
    "packages/web/",
    "packages/client/",
    "packages/api/remotes/",
    "packages/typert/",
    "packages/boot/plugin-manager/",
    "packages/util/timeout/",
    "packages/util/launch-environment/",
    "apps/web/",
    "apps/cli/",
)
IMPORT_RE = re.compile(r"(?:from|import)\s*['\"]([^'\"]+)['\"]")


def run(args: list[str], cwd: Path) -> str:
    result = subprocess.run(args, cwd=cwd, text=True, capture_output=True)
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or result.stdout.strip() or f"command failed: {args}")
    return result.stdout


def clone(repo: str, tag: str, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    run(["git", "clone", "--quiet", "--depth", "1", "--branch", tag, repo, str(destination)], Path.cwd())


def git_sha(root: Path) -> str:
    return run(["git", "-C", str(root), "rev-parse", "HEAD"], Path.cwd()).strip()


def release_metadata(repo: str, tag: str) -> dict[str, Any]:
    # Accept the normal GitHub URL and its .git form; release metadata is
    # optional so a valid tag checkout still produces useful source evidence.
    match = re.search(r"github\.com[:/]([^/]+/[^/]+?)(?:\.git)?$", repo)
    if match is None:
        return {"available": False, "reason": "not a GitHub repository URL"}
    slug = match.group(1)
    url = f"https://api.github.com/repos/{slug}/releases/tags/{tag}"
    request = urllib.request.Request(url, headers={"Accept": "application/vnd.github+json", "User-Agent": "dsh-release-upgrade-skill"})
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            payload = json.load(response)
        return {
            "available": True,
            "url": url,
            "tag_name": payload.get("tag_name"),
            "name": payload.get("name"),
            "published_at": payload.get("published_at"),
            "body": payload.get("body", ""),
            "html_url": payload.get("html_url"),
        }
    except (OSError, urllib.error.URLError, json.JSONDecodeError) as error:
        return {"available": False, "url": url, "reason": str(error)}


def read_package_files(root: Path) -> dict[str, dict[str, Any]]:
    packages: dict[str, dict[str, Any]] = {}
    for path in root.rglob("package.json"):
        if any(part in {".git", "node_modules", "dist", "snapshots"} for part in path.parts):
            continue
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            continue
        if isinstance(value, dict) and isinstance(value.get("name"), str):
            packages[str(path.relative_to(root))] = value
    return packages


def package_delta(baseline: Path, target: Path) -> list[dict[str, Any]]:
    before = read_package_files(baseline)
    after = read_package_files(target)
    rows: list[dict[str, Any]] = []
    for relative in sorted(set(before) | set(after)):
        old = before.get(relative, {})
        new = after.get(relative, {})
        if old == new:
            continue
        row: dict[str, Any] = {
            "path": relative,
            "name": new.get("name", old.get("name")),
            "baselineVersion": old.get("version"),
            "targetVersion": new.get("version"),
        }
        for field in ("dependencies", "devDependencies", "peerDependencies", "peerDependenciesMeta", "dsh"):
            if old.get(field) != new.get(field):
                row[field] = {"baseline": old.get(field), "target": new.get(field)}
        rows.append(row)
    return rows


def changed_paths(baseline: Path, target: Path) -> tuple[list[str], str]:
    # Compare commits, not checkout directories: --no-index also traverses
    # their .git metadata and reports unrelated index/pack changes as source.
    baseline_sha = git_sha(baseline)
    target_sha = git_sha(target)
    run(["git", "-C", str(baseline), "fetch", "--quiet", "--no-tags", str(target), "HEAD"], Path.cwd())
    names = run(
        ["git", "-C", str(baseline), "diff", "--name-status", "--no-renames", baseline_sha, target_sha],
        Path.cwd(),
    )
    diff = run(
        ["git", "-C", str(baseline), "diff", "--no-renames", baseline_sha, target_sha],
        Path.cwd(),
    )
    rows: list[str] = []
    for line in names.splitlines():
        fields = line.split("\t")
        if len(fields) < 2:
            continue
        status = fields[0]
        path = fields[-1]
        rows.append(f"{status}\t{path}")
    return rows, diff


def plugin_imports(root: Path) -> list[str]:
    imports: set[str] = set()
    for path in (root / "src").rglob("*.ts"):
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        imports.update(IMPORT_RE.findall(text))
    return sorted(imports)


def risk_paths(rows: list[str]) -> list[str]:
    selected: list[str] = []
    for row in rows:
        path = row.split("\t")[-1]
        normalized = path.replace(str(Path.cwd()), "")
        if any(root in normalized for root in RISK_ROOTS):
            selected.append(row)
    return selected


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target", required=True, help="target DSH tag, e.g. dsh-v0.1.7-rc.2")
    parser.add_argument("--baseline", help="baseline DSH tag; defaults to package.json's sole dshReleases record")
    parser.add_argument("--repo", default=DEFAULT_REPO)
    parser.add_argument("--out", required=True, help="new output directory")
    args = parser.parse_args(argv)

    output = Path(args.out).expanduser().resolve()
    output.mkdir(parents=True, exist_ok=False)
    errors: list[str] = []
    baseline_tag = args.baseline
    if baseline_tag is None:
        try:
            manifest = json.loads((Path.cwd() / "package.json").read_text(encoding="utf-8"))
            releases = manifest.get("dsh", {}).get("compatibility", {}).get("dshReleases", {})
            if len(releases) != 1:
                raise ValueError("package.json must declare exactly one dshReleases record; pass --baseline")
            baseline_tag = f"dsh-v{next(iter(releases))}"
        except (OSError, json.JSONDecodeError, ValueError, StopIteration) as error:
            print(f"cannot determine baseline: {error}", file=sys.stderr)
            return 2

    baseline = output / "source-baseline"
    target = output / "source-target"
    try:
        release = release_metadata(args.repo, args.target)
        (output / "release.json").write_text(json.dumps(release, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        clone(args.repo, baseline_tag, baseline)
        clone(args.repo, args.target, target)
        rows, diff = changed_paths(baseline, target)
        (output / "changed-files.txt").write_text("\n".join(rows) + ("\n" if rows else ""), encoding="utf-8")
        (output / "diff.txt").write_text(diff, encoding="utf-8")
        packages = package_delta(baseline, target)
        (output / "package-delta.json").write_text(json.dumps(packages, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        imports = plugin_imports(Path.cwd())
        (output / "imports.json").write_text(json.dumps(imports, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        metadata = {
            "baseline": baseline_tag,
            "target": args.target,
            "baselineSha": git_sha(baseline),
            "targetSha": git_sha(target),
            "changedFileCount": len(rows),
            "changedPackageCount": len(packages),
            "highRiskChangedPathCount": len(risk_paths(rows)),
            "errors": errors,
        }
        (output / "manifest.json").write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        report = [
            f"DSH release audit: {baseline_tag} -> {args.target}",
            f"baseline sha: {metadata['baselineSha']}",
            f"target sha:   {metadata['targetSha']}",
            f"changed paths: {len(rows)}",
            f"changed published package manifests: {len(packages)}",
            "",
            "High-risk changed paths:",
            *(f"  {row}" for row in risk_paths(rows)),
            "",
            "Changed package manifests:",
            *(f"  {row['name']} {row['baselineVersion']} -> {row['targetVersion']} ({row['path']})" for row in packages),
            "",
            "Plugin package imports:",
            *(f"  {item}" for item in imports),
            "",
            "Next: review the source delta and run npm run test:engine against the target.",
        ]
        (output / "report.txt").write_text("\n".join(report) + "\n", encoding="utf-8")
        print(f"DSH release evidence written to {output}")
        print(f"changed paths: {len(rows)}; changed package manifests: {len(packages)}")
        return 0
    except (OSError, RuntimeError, subprocess.SubprocessError) as error:
        errors.append(str(error))
        (output / "manifest.json").write_text(json.dumps({"baseline": baseline_tag, "target": args.target, "errors": errors}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"DSH release collection failed: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
