#!/usr/bin/env python3
"""Nib's rebrand pass over the VectorCraft sources (see docs/FORK.md).

Run it from anywhere after merging a new upstream revision into nib/; it is idempotent:

    python3 nib/scripts/nib-rebrand.py          # rewrite in place
    python3 nib/scripts/nib-rebrand.py --check  # list what it would change, exit 1 if anything

What it does, and nothing else:

* Rust sources: on every line that is not a `//` comment, the product name `VectorCraft` (a whole
  word, not `VectorCraft_…`, `%VectorCraft…` or `VectorCraftData`) becomes `Nib`. Lines that name
  the upstream project on purpose are left alone: they carry `upstream-ok`, or one of the markers
  in KEEP_LINE (file-format markers VectorCraft reads back, the native file's `generator`, credits).
* Interface catalogues (crates/ui-egui/src/i18n/*.tsv): the same in both columns, with the case
  endings some languages put on the name (Finnish, Hungarian, Korean, Turkish) adjusted for "Nib".
* Every text file: the application id `ai.storyteller.vectorcraft` becomes `io.github.nihalpi1212.nib`.

Crate names, the native format's id (`"format": "vectorcraft"`), environment variables
(`VECTORCRAFT_*`), comments and docs are never touched here; FORK.md lists what was renamed by hand.
"""

import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent

APP_ID_OLD = "ai.storyteller.vectorcraft"
APP_ID_NEW = "io.github.nihalpi1212.nib"
APP_ID = re.compile(re.escape(APP_ID_OLD) + r"(?!\.document)")

# Files whose `VectorCraft` strings are upstream facts or file-format data.
KEEP_FILES = {
    "crates/doc/src/twist.rs",  # reads the `generator` of files VectorCraft wrote
    "crates/doc/src/twist/tests.rs",
    "xtask/src/brands.rs",
    "xtask/src/test262.rs",  # developer tooling user agent
    "xtask/src/affinity_corpus.rs",
    "scripts/nib-rebrand.py",
}
KEEP_DIRS = ("target/", "crates/plugins/example/", "contributors/")

# A line holding one of these keeps its `VectorCraft`.
KEEP_LINE = (
    "upstream-ok",
    "VectorCraft editing data",  # PDF editing-data marker read back on open
    "VectorCraft, editing data for Illustrator",  # EPS/AI creator line read back on open
    "Product =>",  # PostScript `product` operator of the EPS interpreter
    "and later (version",  # native format versions are VectorCraft releases
    "Icons: Lucide",  # credit: VectorCraft's own icon set
    "based on VectorCraft",
    "Generic CMYK (SWOP-like)",  # a colour profile name documents store
    "VectorCraft plate",  # separation markers read back from exported files
    "VectorCraft clip",
    "VectorCraft (upstream project)",
    "storytold/vectorcraft",
    '"VectorCraft 0.',
    '"VectorCraft 1.',
    'Some("VectorCraft")',
    '"generator":"VectorCraft',
    'strip_prefix("VectorCraft',
)

WORD = re.compile(r"(?<![A-Za-z0-9_%])VectorCraft(?![A-Za-z0-9_])")
# After an escape in a string literal (`"\nVectorCraft hang report"`).
ESCAPED = re.compile(r"(?<=\\[nt])VectorCraft(?![A-Za-z0-9_])")

# The shipped binaries are `nib` and `nib-cli` (the packages keep VectorCraft's names). In the
# app, the CLI, the MCP server, the engine and the interface, text that names a binary follows.
BINARY_DIRS = ("apps/", "crates/mcp/", "crates/engine/src/", "crates/ui-egui/src/")
BINARY_SKIP = ("temp_dir", "tempfile", ".name(", "#[path", '"-p"')
BINARY = [
    (re.compile(r"_BIN_EXE_vectorcraft-cli\b"), "_BIN_EXE_nib-cli"),
    (re.compile(r"_BIN_EXE_vectorcraft_cli\b"), "_BIN_EXE_nib_cli"),
    (re.compile(r"_BIN_EXE_vectorcraft\b(?![-_])"), "_BIN_EXE_nib"),
    (re.compile(r"(?<![A-Za-z0-9_/.-])vectorcraft-cli(?![A-Za-z0-9_-])"), "nib-cli"),
    (re.compile(r"(?<![A-Za-z0-9_/.-])vectorcraft(?= --| \[options\]|: |\.exe)"), "nib"),
    (re.compile(r"Usage: vectorcraft "), "Usage: nib "),
]

# Case endings in the catalogues: VectorCraft + ending -> Nib + ending.
INFLECTIONS = [
    ("VectorCraftia", "Nibiä"),  # fi partitive (front vowels)
    ("VectorCraftissa", "Nibissä"),  # fi inessive
    ("VectorCraftista", "Nibistä"),  # fi elative
    ("VectorCraftiin", "Nibiin"),  # fi illative
    ("VectorCraftin", "Nibin"),  # fi genitive
    ("VectorCraftban", "Nibben"),  # hu inessive
    ("VectorCraftból", "Nibből"),  # hu elative
    ("VectorCraft'ın", "Nib'in"),  # tr genitive
    ("VectorCraft'ı", "Nib'i"),  # tr accusative
    ("VectorCraft'a", "Nib'e"),  # tr dative
    ("VectorCraft가", "Nib이"),  # ko subject particle after a consonant
    ("VectorCraft는", "Nib은"),  # ko topic particle
    ("VectorCraft를", "Nib을"),  # ko object particle
    ("VectorCraft와", "Nib과"),  # ko "and"
    ("VectorCraft로", "Nib으로"),  # ko "with/to"
    ("VectorCraftu", "Nibu"),  # cs/bs/pl locative, genitive
    ("VectorCrafta", "Niba"),  # bs/pl genitive
    ("VectorCrafts", "Nibs"),  # sv/da/de/nl genitive
    ("VectorCraftis", "Nibis"),
]
INFLECTED = re.compile(r"(?<![A-Za-z0-9_%])(" + "|".join(re.escape(a) for a, _ in INFLECTIONS) + r")(?![A-Za-z0-9_])")
INFLECTION_MAP = dict(INFLECTIONS)

TEXT_SUFFIXES = {
    ".rs", ".toml", ".md", ".sh", ".ps1", ".wxs", ".wxl", ".wxi", ".xml", ".in", ".yml", ".yaml",
    ".json", ".desktop", ".html", ".py", ".txt", ".tsv", ".plist", ".svg",
}


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
    return ESCAPED.sub("Nib", WORD.sub("Nib", line))


def tsv_line(line: str) -> str:
    if line.startswith("#") or any(k in line for k in KEEP_LINE):
        return line
    for pattern, new in BINARY:
        line = pattern.sub(new, line)
    line = INFLECTED.sub(lambda m: INFLECTION_MAP[m.group(1)], line)
    return WORD.sub("Nib", line)


def rewrite(path: pathlib.Path, rel: str) -> str | None:
    try:
        text = path.read_text(encoding="utf-8")
    except (UnicodeDecodeError, OSError):
        return None
    # VectorCraft's own document type (`ai.storyteller.vectorcraft.document`), which Nib's macOS
    # bundle imports to open `.vectorcraft` files, keeps its id.
    out = APP_ID.sub(APP_ID_NEW, text) if rel != "scripts/nib-rebrand.py" else text
    if not keep_file(rel):
        if path.suffix == ".rs":
            binaries = rel.startswith(BINARY_DIRS)
            out = "".join(rust_line(l, binaries) for l in out.splitlines(keepends=True))
        elif path.suffix == ".tsv" and rel.startswith("crates/ui-egui/src/i18n/"):
            out = "".join(tsv_line(l) for l in out.splitlines(keepends=True))
    return out if out != text else None


def main() -> int:
    check = "--check" in sys.argv[1:]
    changed = []
    for path in sorted(ROOT.rglob("*")):
        rel = path.relative_to(ROOT).as_posix()
        if not path.is_file() or rel.startswith(("target/", ".git/")) or path.suffix not in TEXT_SUFFIXES:
            continue
        if rel.startswith("docs/") and path.suffix == ".md":
            continue  # VectorCraft's own documentation keeps its history
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
