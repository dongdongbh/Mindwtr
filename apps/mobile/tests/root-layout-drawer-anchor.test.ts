import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// #1066: the iOS Lock Screen/Control Center "Add Task" widget deep-links to
// the root capture modal. On a cold launch the root Stack's default initial
// route is `index`, whose session-restore Redirect calls router.replace and
// would replace the deep-linked modal with Focus, so the capture sheet never
// appeared. Anchoring the root stack on the drawer group keeps `index` out
// of the stack for root-level deep links, so the modal survives. This test
// pins that anchor directly in app/_layout.tsx's source, since importing the
// module would drag in native modules the layout depends on.
describe('root layout anchor (#1066)', () => {
  it('anchors the root stack on the drawer group', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'app/_layout.tsx'),
      'utf8',
    );

    const match = source.match(
      /export const unstable_settings\s*=\s*{\s*anchor:\s*(['"])(.*?)\1/,
    );

    expect(match, 'expected app/_layout.tsx to export unstable_settings.anchor').not.toBeNull();
    expect(match?.[2]).toBe('(drawer)');
  });
});
