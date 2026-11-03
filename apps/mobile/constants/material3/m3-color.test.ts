import { describe, expect, it } from 'vitest';
import { M3Colors, type M3ColorRoles } from './m3-color';

const REQUIRED_ROLES: (keyof M3ColorRoles)[] = [
  'primary','onPrimary','primaryContainer','onPrimaryContainer',
  'secondary','onSecondary','secondaryContainer','onSecondaryContainer',
  'tertiary','onTertiary','tertiaryContainer','onTertiaryContainer',
  'error','onError','errorContainer','onErrorContainer',
  'background','onBackground','surface','onSurface','surfaceVariant','onSurfaceVariant',
  'surfaceContainerLowest','surfaceContainerLow','surfaceContainer','surfaceContainerHigh','surfaceContainerHighest',
  'outline','outlineVariant','inverseSurface','inverseOnSurface','inversePrimary',
  'surfaceTint','scrim','shadow','success','onSuccess','warning','onWarning','text','secondaryText',
];

describe('M3Colors', () => {
  it.each(['light','dark'] as const)('%s defines every required role as a hex string', (scheme) => {
    for (const role of REQUIRED_ROLES) {
      expect(M3Colors[scheme][role], `${scheme}.${role}`).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });
  it('preserves the existing seed values that already shipped', () => {
    expect(M3Colors.light.primary).toBe('#1B6EF3');
    expect(M3Colors.light.primaryContainer).toBe('#D7E2FF');
    expect(M3Colors.light.surfaceContainer).toBe('#EEF1F7');
    expect(M3Colors.dark.primary).toBe('#AAC7FF');
    expect(M3Colors.dark.surface).toBe('#111318');
  });
  it('orders the tonal surface ladder from lowest to highest (light gets lighter)', () => {

    expect(M3Colors.light.surfaceContainerLowest).toBe('#FFFFFF');
  });
});
