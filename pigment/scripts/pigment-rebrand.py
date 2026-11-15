#!/usr/bin/env python3
"""Pigment's rebrand pass over the PhotoCraft sources (see docs/FORK.md).

Run it from anywhere after merging a new upstream revision into pigment/; it is idempotent:

    python3 pigment/scripts/pigment-rebrand.py          # rewrite in place
    python3 pigment/scripts/pigment-rebrand.py --check  # list what it would change, exit 1 if anything

What it does, and nothing else:

* Rust sources: on every line that is not a `//` comment, the product name `PhotoCraft` (a whole
  word, not `PhotoCraft_...`, `%PhotoCraft...` or `PhotoCraftData`) becomes `Pigment`. Lines that
  name the upstream project on purpose are left alone: they carry `upstream-ok`, or one of the
  markers in KEEP_LINE (file markers PhotoCraft reads back, credits, upstream links).
* Rust sources of the app, the CLI, the automation/MCP crate, the engine and the interface: text
  that names a binary (`photocraft --help`, `photocraft: ...`, `photocraft-cli`, `photocraft.exe`,
  `CARGO_BIN_EXE_photocraft`) names Pigment's (`pigment`, `pigment-cli`).
* Every text file: the application id `ai.storyteller.photocraft` becomes
  `io.github.nihalpi1212.pigment`, except PhotoCraft's own document type
  (`ai.storyteller.photocraft.document`), which Pigment's macOS bundle imports to open `.pcraft`.

The interface translations are not in this tree: crates/ui-egui/build.rs rebrands the craft-i18n
catalogs it embeds, with the same rules and the case endings some languages put on the name.

Crate names, the native format's id, environment variables (`PHOTOCRAFT_*`), comments and docs
are never touched here; FORK.md lists what was renamed by hand.
"""

import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent

APP_ID_OLD = "ai.storyteller.photocraft"
APP_ID_NEW = "io.github.nihalpi1212.pigment"
APP_ID = re.compile(re.escape(APP_ID_OLD) + r"(?![A-Za-z0-9_-])(?!\.document(?![A-Za-z0-9_-]))")

SELF = "scripts/pigment-rebrand.py"

# Files whose `PhotoCraft` strings are upstream facts, file-format data or developer tooling.
KEEP_FILES = {
    SELF,
}
KEEP_DIRS = ("target/", "contributors/", "xtask/", "examples/", "docs/", "book/", "perf/", "scorecard/", "tests/")

# A line holding one of these keeps its `PhotoCraft`.
KEEP_LINE = (
    "upstream-ok",
    "const TOOLKIT",  # the XMP toolkit Camera Raw sidecars carry; `is_photocraft_xmp` reads it back
    "xmptk=",  # the tests of that marker
    "CaseProbe",  # a case-sensitivity probe: the name must differ from its lower-case twin by case only
    'replacen("PhotoCraft", "photocraft"',
    "-face-",  # hidden font-face aliases, internal names
    "gamma 1.732, PhotoCraft",  # craft-cms's profile description
    "PhotoCraft Studio CMYK",  # a profile description a test document carries
    "PhotoCraft contributors",  # credits
    "PhotoCraft authors",  # copyright line
    "based on PhotoCraft",
    "PhotoCraft (upstream project)",
    "PhotoCraft by the ArtCraft team",
    "storytold/photocraft",
    "UPSTREAM_NAME",
)

WORD = re.compile(r"(?<![A-Za-z0-9_%])PhotoCraft(?![A-Za-z0-9_])")
# After an escape in a string literal (`"\nPhotoCraft could not start"`).
ESCAPED = re.compile(r"(?<=\\[nt])PhotoCraft(?![A-Za-z0-9_])")

# The shipped binaries are `pigment` and `pigment-cli` (the packages keep PhotoCraft's names). In
# the app, the CLI, the automation/MCP crate, the engine and the interface, text that names a
# binary follows.
BINARY_DIRS = ("apps/photocraft/", "apps/photocraft-cli/", "crates/automation/", "crates/engine/src/", "crates/ui-egui/src/")
BINARY_SKIP = ("temp_dir", "tempfile", ".name(", "#[path", '"-p"', "level_for", "Filter::parse", "record(log::")
BINARY = [
    (re.compile(r"_BIN_EXE_photocraft-cli\b"), "_BIN_EXE_pigment-cli"),
    (re.compile(r"_BIN_EXE_photocraft_cli\b"), "_BIN_EXE_pigment_cli"),
    (re.compile(r"_BIN_EXE_photocraft\b(?![-_])"), "_BIN_EXE_pigment"),
    (re.compile(r"(?<![A-Za-z0-9_./-])photocraft-cli(?![A-Za-z0-9_-])"), "pigment-cli"),
    (re.compile(r"(?<=MacOS/)photocraft-cli(?![A-Za-z0-9_-])"), "pigment-cli"),
    (re.compile(r"(?<![A-Za-z0-9_./-])photocraft(?= --| \[options\]| \[OPTIONS\]|: |\.exe| a\.psd| \.\.\.| …)"), "pigment"),
    (re.compile(r"(?<=\\)photocraft(?=\.exe)"), "pigment"),
    (re.compile(r"Usage: photocraft "), "Usage: pigment "),
]

TEXT_SUFFIXES = {
    ".rs", ".toml", ".md", ".sh", ".ps1", ".wxs", ".wxl", ".wxi", ".xml", ".in", ".yml", ".yaml",
    ".json", ".desktop", ".html", ".py", ".txt", ".tsv", ".plist", ".svg", ".js", ".webmanifest",
}
TEXT_NAMES = {"AppRun"}


def keep_file(rel: str) -> bool:
    return rel in KEEP_FILES or rel.startswith(KEEP_DIRS)


def rust_line(line: str, binaries: bool = False) -> str:
    if line.lstrip().startswith("//"):
        return line
    if binaries and not any(k in line for k in BINARY_SKIP):
        for pattern, new in BINARY:
            line = pattern.sub(new, line)
    if any(k in line for k in KEEP_LINE):
        return line
    return ESCAPED.sub("Pigment", WORD.sub("Pigment", line))


def rewrite(path: pathlib.Path, rel: str) -> str | None:
    try:
        text = path.read_text(encoding="utf-8")
    except (UnicodeDecodeError, OSError):
        return None
    out = text if rel == SELF else APP_ID.sub(APP_ID_NEW, text)
    if path.suffix == ".rs" and not keep_file(rel):
        binaries = rel.startswith(BINARY_DIRS)
        out = "".join(rust_line(line, binaries) for line in out.splitlines(keepends=True))
    return out if out != text else None


def main() -> int:
    check = "--check" in sys.argv[1:]
    changed = []
    for path in sorted(ROOT.rglob("*")):
        rel = path.relative_to(ROOT).as_posix()
        if not path.is_file() or rel.startswith(("target/", ".git/")):
            continue
        if path.suffix not in TEXT_SUFFIXES and path.name not in TEXT_NAMES:
            continue
        if rel.startswith(("docs/", "book/")) and path.suffix == ".md":
            continue  # PhotoCraft's own documentation keeps its history
        if rel.startswith("contributors/"):
            continue
        new = rewrite(path, rel)
        if new is None:
            continue
        changed.append(rel)
        if not check:
            path.write_text(new, encoding="utf-8")
    for rel in changed:
        print(("would change " if check else "changed ") + rel)
    return 1 if check and changed else 0


if __name__ == "__main__":
    sys.exit(main())
