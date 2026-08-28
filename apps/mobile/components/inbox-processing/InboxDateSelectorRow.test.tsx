import React from 'react';
import { TouchableOpacity } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { safeFormatDate } from '@mindwtr/core';
import { describe, expect, it, vi } from 'vitest';

import { FALLBACK_THEME_COLORS } from '@/hooks/use-theme-colors';

import { InboxDateSelectorRow } from './InboxDateSelectorRow';

const value = new Date('2026-08-27T12:00:00.000Z');

type RenderOptions = {
  clearLabel?: string;
  dateOnly?: boolean;
  dateOnlyLabel?: string;
  defaultScheduleTime?: string;
  label: string;
  notSetLabel?: string;
  t?: (key: string) => string;
};

function renderRow({
  clearLabel = 'Clear',
  dateOnly = false,
  dateOnlyLabel = 'Date only',
  defaultScheduleTime = '09:00',
  label,
  notSetLabel = 'Not set',
  t = (key) => ({
    'quickDate.today': 'Today',
    'settings.gtdMobile.defaultScheduleTime': 'Default schedule time',
  }[key] ?? key),
}: RenderOptions) {
  const actions = {
    onClear: vi.fn(),
    onDateOnly: vi.fn(),
    onOpen: vi.fn(),
    onQuickDateSelect: vi.fn(),
    onUseDefaultTime: vi.fn(),
  };
  let tree!: ReactTestRenderer;
  act(() => {
    tree = create(
      <InboxDateSelectorRow
        {...actions}
        clearLabel={clearLabel}
        dateOnly={dateOnly}
        dateOnlyLabel={dateOnlyLabel}
        defaultScheduleTime={defaultScheduleTime}
        label={label}
        notSetLabel={notSetLabel}
        t={t}
        tc={FALLBACK_THEME_COLORS}
        value={value}
      />
    );
  });
  return { actions, tree };
}

describe('InboxDateSelectorRow accessibility', () => {
  it.each(['Start date', 'Due date', 'Review date'])(
    'gives the %s controls field-specific button names and a selected value',
    (label) => {
      const { actions, tree } = renderRow({ label });
      const buttons = tree.root.findAllByType(TouchableOpacity);
      const open = buttons.find((button) => button.props.accessibilityLabel === label);
      const clear = buttons.find((button) => button.props.accessibilityLabel === `${label}: Clear`);
      const dateOnly = buttons.find((button) => button.props.accessibilityLabel === `${label}: Date only`);
      const quickToday = tree.root.findByProps({
        accessibilityLabel: `${label}: Today`,
        accessibilityRole: 'button',
      });

      expect(open?.props).toMatchObject({
        accessibilityRole: 'button',
        accessibilityValue: { text: safeFormatDate(value.toISOString(), 'P') },
      });
      expect(clear?.props.accessibilityRole).toBe('button');
      expect(dateOnly?.props.accessibilityRole).toBe('button');

      act(() => {
        open?.props.onPress();
        clear?.props.onPress();
        dateOnly?.props.onPress();
        quickToday.props.onPress();
      });
      expect(actions.onOpen).toHaveBeenCalledOnce();
      expect(actions.onClear).toHaveBeenCalledOnce();
      expect(actions.onDateOnly).toHaveBeenCalledOnce();
      expect(actions.onQuickDateSelect).toHaveBeenCalledOnce();
      expect(actions.onUseDefaultTime).not.toHaveBeenCalled();
    }
  );

  it('names the default-time action and preserves its existing behavior', () => {
    const { actions, tree } = renderRow({ dateOnly: true, label: 'Start date' });
    const defaultTime = tree.root.findByProps({
      accessibilityLabel: 'Start date: Default schedule time: 09:00',
      accessibilityRole: 'button',
    });

    act(() => defaultTime.props.onPress());

    expect(actions.onUseDefaultTime).toHaveBeenCalledOnce();
    expect(actions.onDateOnly).not.toHaveBeenCalled();
  });

  it('keeps field and action names unambiguous with RTL copy', () => {
    const t = (key: string) => key === 'settings.gtdMobile.defaultScheduleTime'
      ? 'وقت الجدولة الافتراضي'
      : key;
    const { tree } = renderRow({
      clearLabel: 'مسح',
      dateOnlyLabel: 'التاريخ فقط',
      label: 'تاريخ المراجعة',
      notSetLabel: 'غير محدد',
      t,
    });

    expect(tree.root.findByProps({
      accessibilityLabel: 'تاريخ المراجعة',
      accessibilityRole: 'button',
    }).props.accessibilityValue).toEqual({ text: safeFormatDate(value.toISOString(), 'P') });
    expect(tree.root.findByProps({
      accessibilityLabel: 'تاريخ المراجعة: مسح',
      accessibilityRole: 'button',
    })).toBeDefined();
    expect(tree.root.findByProps({
      accessibilityLabel: 'تاريخ المراجعة: التاريخ فقط',
      accessibilityRole: 'button',
    })).toBeDefined();
  });
});
