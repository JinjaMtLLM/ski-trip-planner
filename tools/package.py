#!/usr/bin/env python3
"""把 skill 打包成可分发的 zip。

与 WorkBuddy 自带的 package_skill.py 的区别：那个用 rglob('*') 全量收集，
没有排除规则，会把 .git/ 一起打进去。本脚本改用 git 的文件清单，
因此天然遵守 .gitignore，只在仓库里时才可用。

用法:
    python tools/package.py                 # 输出到 ./dist/ski-trip-planner.zip
    python tools/package.py -o /tmp/dist    # 指定输出目录

原则：只打包「被 git 跟踪的文件 + 未被忽略的新文件」，
并以 <仓库目录名>/ 作为 zip 内的顶层目录（与官方打包器保持一致）。
"""

from __future__ import annotations

import argparse
import subprocess
import sys
import zipfile
from pathlib import Path

# 仅开发期使用、不该出现在分发产物里的文件与前缀
EXCLUDE_PREFIXES = ("tools/",)
EXCLUDE_FILES = {".gitignore"}


def skill_name_of(root: Path) -> str:
    """从 SKILL.md 的 frontmatter 读 name，而不是用目录名——
    开发目录可以随便叫，安装目录必须与 name 一致。"""
    text = (root / "SKILL.md").read_text(encoding="utf-8")
    if text.startswith("---"):
        for line in text.splitlines()[1:]:
            if line.strip() == "---":
                break
            if line.startswith("name:"):
                return line.split(":", 1)[1].strip().strip("\"'")
    sys.exit("✗ SKILL.md 的 frontmatter 里没有 name 字段。")


def repo_root() -> Path:
    out = subprocess.run(
        ["git", "rev-parse", "--show-toplevel"],
        capture_output=True, text=True, check=False,
    )
    if out.returncode != 0:
        sys.exit("✗ 当前目录不是 git 仓库，无法确定文件清单。")
    return Path(out.stdout.strip())


def list_files(root: Path) -> list[Path]:
    """已跟踪 + 未忽略的新文件，NUL 分隔以兼容非 ASCII 文件名。"""
    out = subprocess.run(
        ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
        cwd=root, capture_output=True, check=True,
    )
    names = [n for n in out.stdout.decode("utf-8").split("\0") if n]
    files = []
    for n in names:
        p = Path(n)
        if any(n.startswith(pref) for pref in EXCLUDE_PREFIXES):
            continue
        if n in EXCLUDE_FILES:
            continue
        if (root / p).is_file():
            files.append(p)
    return sorted(set(files))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("-o", "--out-dir", default="dist", help="输出目录，默认 dist/")
    args = ap.parse_args()

    root = repo_root()
    skill_name = skill_name_of(root)
    files = list_files(root)
    if not files:
        sys.exit("✗ 没有可打包的文件。")
    if not any(f.name == "SKILL.md" for f in files):
        sys.exit("✗ 缺少 SKILL.md，不是合法的 skill 目录。")

    out_dir = Path(args.out_dir)
    if not out_dir.is_absolute():
        out_dir = root / out_dir
    out_dir.mkdir(parents=True, exist_ok=True)
    zip_path = out_dir / f"{skill_name}.zip"

    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for f in files:
            zf.write(root / f, arcname=str(Path(skill_name) / f))

    size = zip_path.stat().st_size
    print(f"✓ {zip_path}  ({size / 1024:.1f} KB, {len(files)} 个文件)")
    for f in files:
        print(f"    {f}")


if __name__ == "__main__":
    main()
