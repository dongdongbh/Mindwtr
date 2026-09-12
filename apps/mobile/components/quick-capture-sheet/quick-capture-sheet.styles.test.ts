import { describe, expect, it } from 'vitest';

import { styles } from './quick-capture-sheet.styles';

const flattenStyle = (value: any): Record<string, unknown> => (
  Array.isArray(value)
    ? Object.assign({}, ...value.map(flattenStyle))
    : value
);

describe('quick capture sheet styles', () => {
  it('keeps option chips wide enough before wrapping at large font settings', () => {
    expect(flattenStyle(styles.optionChip)).toMatchObject({
      flexBasis: 120,
      flexGrow: 1,
      flexShrink: 1,
    });
    expect(flattenStyle(styles.customDateButton)).toMatchObject({
      flexBasis: 120,
      flexGrow: 1,
      flexShrink: 1,
    });
    expect(flattenStyle(styles.optionText)).toMatchObject({
      textAlign: 'center',
    });
  });

  it('gives the quick-capture close action a comfortable touch target', () => {
    expect(flattenStyle(styles.closeButton)).toMatchObject({
      height: 48,
      width: 48,
    });
  });
});
