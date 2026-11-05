import { describe, expect, test } from 'bun:test';
import { fieldValues, findFeatureMapProblems, type MapInput } from './check-feature-map';

const page = (lines: string[]) => lines.join('\n');

const cleanInput = (): MapInput => ({
    pages: {
        'desktop.md': page(['## Inbox', '- Selectors: `inbox-list`', '- Code: `apps/desktop/src/Inbox.tsx`', '- Checks: `e2e/clarify.spec.ts`']),
        'mobile.md': page(['## Inbox', '- Selectors: `task-row-`']),
        'android-native.md': page(['## Capture', '- Checks: `apps/android-native/scripts/check-capture-device.mjs`']),
        'ios-native.md': page(['## Inbox']),
    },
    sources: {
        'apps/desktop/src': '<ul data-testid="inbox-list">',
        'apps/mobile': 'testID={`task-row-${task.id}`}',
        'apps/android-native': '',
        'apps/ios-native': '',
    },
    trackedFiles: ['apps/android-native/scripts/check-capture-device.mjs', 'apps/android-native/scripts/device.mjs'],
    exists: (path) => ['apps/desktop/src/Inbox.tsx', 'e2e/clarify.spec.ts', 'apps/android-native/scripts/check-capture-device.mjs'].includes(path),
});

describe('feature map check', () => {
    test('passes a map whose paths, selectors and device scripts all resolve', () => {
        expect(findFeatureMapProblems(cleanInput())).toEqual([]);
    });

    test('reports a Code or Checks path that does not exist', () => {
        const input = cleanInput();
        input.pages['desktop.md'] += '\n- Code: `apps/desktop/src/Gone.tsx`';
        expect(findFeatureMapProblems(input)).toEqual(['desktop.md: Code path does not exist: apps/desktop/src/Gone.tsx']);
    });

    test('reports a selector that no quoted source string contains', () => {
        const input = cleanInput();
        input.sources['apps/desktop/src'] = '<ul data-testid="inbox-items">';
        expect(findFeatureMapProblems(input)).toEqual(['desktop.md: selector not found in apps/desktop/src: inbox-list']);
    });

    test('does not accept a selector that appears only as unquoted text', () => {
        const input = cleanInput();
        input.sources['apps/desktop/src'] = 'const inbox-list = 1';
        expect(findFeatureMapProblems(input)).toHaveLength(1);
    });

    test('reports a device check script that no Checks line lists', () => {
        const input = cleanInput();
        input.trackedFiles.push('apps/android-native/scripts/check-editor-device.mjs');
        expect(findFeatureMapProblems(input)).toEqual([
            'android-native.md: device script is not on any Checks line: apps/android-native/scripts/check-editor-device.mjs',
        ]);
    });

    test('reports a missing surface page', () => {
        const input = cleanInput();
        delete input.pages['ios-native.md'];
        expect(findFeatureMapProblems(input)).toEqual(['ios-native.md: page is missing']);
    });

    test('ignores example entries inside code fences', () => {
        const markdown = page(['```markdown', '- Code: `apps/fenced.tsx`', '```', '- Code: `apps/real.tsx`']);
        expect(fieldValues(markdown, 'Code')).toEqual(['apps/real.tsx']);
    });
});
