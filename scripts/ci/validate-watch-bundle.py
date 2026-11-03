#!/usr/bin/env python3
import pathlib
import plistlib
import sys


def read_plist(bundle):
    with (bundle / 'Info.plist').open('rb') as stream:
        return plistlib.load(stream)


def validate(app_path, enabled):
    app_path = pathlib.Path(app_path)
    host = read_plist(app_path)
    watch_apps = list((app_path / 'Watch').glob('*.app'))
    if not enabled:
        if watch_apps:
            raise ValueError('Stable iOS package must not contain a Watch app')
        if host.get('MindwtrWatchEnabled', False):
            raise ValueError('Stable iOS package enables the Watch receiver')
        return
    if host.get('MindwtrWatchEnabled') is not True:
        raise ValueError('A Watch-enabled archive must enable the iPhone receiver')
    watch_path = app_path / 'Watch/MindwtrWatch.app'
    if watch_apps != [watch_path]:
        raise ValueError('A Watch-enabled archive must contain exactly MindwtrWatch.app')
    watch = read_plist(watch_path)
    widget = read_plist(watch_path / 'PlugIns/MindwtrWatchWidgets.appex')
    host_id = host['CFBundleIdentifier']
    if watch.get('WKCompanionAppBundleIdentifier') != host_id:
        raise ValueError('Watch companion identifier does not match iPhone')
    if watch.get('WKRunsIndependentlyOfCompanionApp', False):
        raise ValueError('Mindwtr Watch must remain a companion app')
    for info, expected_id in ((watch, f'{host_id}.watchkitapp'), (widget, f'{host_id}.watchkitapp.widgets')):
        if info.get('CFBundleIdentifier') != expected_id:
            raise ValueError(f'Wrong Watch bundle identifier: {expected_id}')
        for field in ('CFBundleVersion', 'CFBundleShortVersionString'):
            if info.get(field) != host.get(field):
                raise ValueError(f'{expected_id}: {field} must match iPhone')


if __name__ == '__main__':
    if len(sys.argv) != 3 or sys.argv[2] not in ('true', 'false'):
        sys.exit('Usage: validate-watch-bundle.py <iPhone.app> <true|false>')
    try:
        validate(sys.argv[1], sys.argv[2] == 'true')
    except (ValueError, KeyError, OSError) as error:
        sys.exit(f'Watch package validation failed: {error}')
    print('Watch package matches release channel and iPhone metadata')
