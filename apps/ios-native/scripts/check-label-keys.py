import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
APP = ROOT / 'apps/ios-native/App'
KEY = r'[A-Za-z]\w*\.[\w.]*\w'


def label_keys(text):
    keys = set()
    for call in re.finditer(r'\blabel\(((?:[^()]|\([^()]*\))*)\)', text):
        keys.update(re.findall('"(' + KEY + ')"', call.group(1)))
    return keys


def requested_keys(model, sources):
    without_calls = re.sub(r'\blabel\(((?:[^()]|\([^()]*\))*)\)', '', model)
    requested = set(re.findall('"(' + KEY + ')"', without_calls))
    for text in sources:
        for block in re.finditer(r'stringKeys[^=\n]*=\s*\[([^\]]*)\]', text):
            requested.update(re.findall('"(' + KEY + ')"', block.group(1)))
    return requested


def english_keys():
    text = (ROOT / 'packages/core/src/i18n/locales/en.ts').read_text()
    return set(re.findall(r"""^\s*['"](""" + KEY + r""")['"]\s*:""", text, re.M))


def unloaded(app=APP):
    model = (app / 'CoreModel.swift').read_text()
    sources = [path.read_text() for path in (app.parent).rglob('*.swift')]
    requested = requested_keys(model, sources)
    used = {}
    for path in sorted(app.glob('*.swift')):
        for key in label_keys(path.read_text()):
            used.setdefault(key, set()).add(path.name)
    english = english_keys()
    return {key: files for key, files in used.items() if key not in requested and key in english}


def main():
    missing = unloaded()
    for key in sorted(missing):
        print('label key is never requested from core:', key, sorted(missing[key]))
    return 1 if missing else 0


if __name__ == '__main__':
    sys.exit(main())
