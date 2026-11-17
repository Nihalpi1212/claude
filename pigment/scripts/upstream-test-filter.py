#!/usr/bin/env python3
"""The cargo-nextest filter for the tests in scripts/upstream-test-failures.txt.

    python3 scripts/upstream-test-filter.py --skip   # every test but the listed ones (the CI gate)
    python3 scripts/upstream-test-filter.py --only   # the listed tests alone (the non-gating step)

The list names one test per line under a section comment that starts with the package and target,
`# <package> --test <target> (...)`. Each test becomes `package(=<package>) & test(=<name>)`, so a
test of the same name in another package is never skipped by accident.
"""

import pathlib
import re
import sys

LIST = pathlib.Path(__file__).resolve().parent / "upstream-test-failures.txt"
SECTION = re.compile(r"^#\s+([A-Za-z0-9_-]+)\s+--test\s+([A-Za-z0-9_-]+)\b")
NAME = re.compile(r"^[A-Za-z0-9_:]+$")


def groups(text: str) -> dict[str, list[str]]:
    """Package name to its listed tests, in file order."""
    out: dict[str, list[str]] = {}
    package = None
    for number, raw in enumerate(text.splitlines(), 1):
        line = raw.strip()
        if not line:
            continue
        if line.startswith("#"):
            section = SECTION.match(line)
            if section:
                package = section.group(1)
            continue
        if package is None:
            sys.exit(f"{LIST.name}:{number}: a test is listed before any `# <package> --test <target>` section")
        if not NAME.match(line):
            sys.exit(f"{LIST.name}:{number}: not a test name: {line!r}")
        out.setdefault(package, []).append(line)
    return out


def only(found: dict[str, list[str]]) -> str:
    parts = []
    for package, names in found.items():
        tests = " | ".join(f"test(={name})" for name in names)
        parts.append(f"(package(={package}) & ({tests}))")
    return " | ".join(parts)


def main() -> None:
    if len(sys.argv) != 2 or sys.argv[1] not in ("--skip", "--only"):
        sys.exit(__doc__)
    found = groups(LIST.read_text(encoding="utf-8"))
    if not found:
        # Nothing listed: the gate runs everything, and the non-gating step has nothing to run.
        print("all()" if sys.argv[1] == "--skip" else "none()")
        return
    expression = only(found)
    print(f"not ({expression})" if sys.argv[1] == "--skip" else expression)


if __name__ == "__main__":
    main()
