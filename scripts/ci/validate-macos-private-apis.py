#!/usr/bin/env python3
COMMAND_DESCRIPTION = """Reject the known private ICU imports from the 1.3.4 App Store rejection.

This checks undefined Mach-O symbols, not strings or every possible private API.
"""

import argparse
import os
from pathlib import Path
import subprocess
import sys


REJECTED_SYMBOLS = Path(__file__).with_name('macos-rejected-icu-symbols.txt')
MACH_O_MAGICS = {
    bytes.fromhex(magic) for magic in (
        'feedface', 'cefaedfe', 'feedfacf', 'cffaedfe',
        'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca',
    )
}


def validate(app, nm=None):
    app = Path(app)
    if not app.is_dir():
        raise ValueError(f'App bundle directory not found: {app}')
    rejected = {
        line.strip() for line in REJECTED_SYMBOLS.read_text().splitlines()
        if line.strip() and not line.lstrip().startswith('#')
    }
    if not rejected:
        raise ValueError(f'Rejected symbol list is empty: {REJECTED_SYMBOLS}')
    command = [nm or ('/usr/bin/nm' if sys.platform == 'darwin' else 'llvm-nm')]
    command += ['-arch', 'all', '-u'] if sys.platform == 'darwin' else ['--arch=all', '-u']
    scanned = 0
    failures = []

    def fail_walk(error):
        raise error

    for directory, dirs, files in os.walk(app, onerror=fail_walk):
        dirs.sort()
        for name in sorted(files):
            binary = Path(directory) / name
            with binary.open('rb') as stream:
                if stream.read(4) not in MACH_O_MAGICS:
                    continue
            result = subprocess.run([*command, str(binary)], text=True, capture_output=True)
            if result.returncode or result.stderr.strip():
                raise ValueError(f'nm scan failed for {binary}: {result.stderr.strip() or result.returncode}')
            scanned += 1


            imports = {line.split()[-1] for line in result.stdout.splitlines() if line.split()}
            forbidden = sorted(imports & rejected)
            if forbidden:
                failures.append(f'{binary.relative_to(app)}: {", ".join(forbidden)}')
    if not scanned:
        raise ValueError(f'No Mach-O binaries found in {app}')
    if failures:
        raise ValueError('Rejected private ICU imports:\n' + '\n'.join(failures))
    return scanned


def main():
    parser = argparse.ArgumentParser(description=COMMAND_DESCRIPTION)
    parser.add_argument('app', type=Path)
    parser.add_argument('--nm', help='nm executable (Apple nm on macOS, llvm-nm elsewhere)')
    args = parser.parse_args()
    try:
        scanned = validate(args.app, args.nm)
    except (OSError, ValueError) as error:
        print(f'::error::{error}', file=sys.stderr)
        return 1
    print(f'Known rejected ICU import check passed: {scanned} Mach-O binaries, all architectures.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
