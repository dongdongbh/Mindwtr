#!/usr/bin/env python3
"""Disable unused runner vendor feeds, never APT integrity verification.

Only used in the ephemeral Ubuntu Tauri/E2E jobs: their system packages come
from Ubuntu, and Playwright downloads its own pinned Chromium. Leave other
sources, signing options, and the runner's Ubuntu mirror configuration intact.
Supports both APT .list lines and deb822 .sources stanzas.
"""
import argparse
import pathlib
import re
from urllib.parse import urlsplit

UNUSED_HOSTS = {"dl.google.com", "packages.microsoft.com"}
LIST_ENTRY = re.compile(r"^\s*deb(?:-src)?\s+(?:\[[^\]]*\]\s+)?(\S+)")
URI_FIELD = re.compile(r"^URIs:[^\n]*(?:\n[ \t]+[^\n]+)*", re.MULTILINE | re.IGNORECASE)
ENABLED_FIELD = re.compile(r"^Enabled:[^\n]*", re.MULTILINE | re.IGNORECASE)


def unused_uri(uri):
    return urlsplit(uri).hostname in UNUSED_HOSTS


def prepare_list(content):
    lines = []
    for line in content.splitlines(keepends=True):
        match = LIST_ENTRY.match(line)
        if match and unused_uri(match[1]):
            line = "# CI disabled unused vendor feed: " + line
        lines.append(line)
    return "".join(lines)


def prepare_stanza(stanza):
    enabled = ENABLED_FIELD.search(stanza)
    if enabled and enabled[0].split(":", 1)[1].strip().lower() == "no":
        return stanza
    field = URI_FIELD.search(stanza)
    if not field:
        return stanza
    uris = field[0].split(":", 1)[1].split()
    retained = [uri for uri in uris if not unused_uri(uri)]
    if retained == uris:
        return stanza
    if retained:
        return stanza[:field.start()] + "URIs: " + " ".join(retained) + stanza[field.end():]
    if enabled:
        return ENABLED_FIELD.sub("Enabled: no", stanza)
    return stanza.rstrip("\n") + "\nEnabled: no\n"


def prepare_sources(content):
    # Retain separators so untouched Ubuntu stanzas remain byte-for-byte intact.
    parts = re.split(r"(\n[ \t]*\n)", content)
    return "".join(part if index % 2 else prepare_stanza(part)
                   for index, part in enumerate(parts))


def prepare(root):
    paths = [root / "sources.list"]
    source_dir = root / "sources.list.d"
    if source_dir.exists():
        paths += sorted(source_dir.glob("*.list")) + sorted(source_dir.glob("*.sources"))
    for path in paths:
        if not path.is_file():
            continue
        content = path.read_text()
        updated = prepare_sources(content) if path.suffix == ".sources" else prepare_list(content)
        if content != updated:
            path.write_text(updated)
            print(f"Disabled unused vendor APT entries in {path.name}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("apt_root", nargs="?", type=pathlib.Path, default=pathlib.Path("/etc/apt"))
    prepare(parser.parse_args().apt_root)
