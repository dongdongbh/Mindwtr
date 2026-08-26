import React from 'react';
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { CalendarPeriodNavigation } from './calendar-period-navigation';

describe('CalendarPeriodNavigation', () => {
  it.each([
    ['26. August 2026', 'Vorheriger Tag', 'Nächster Tag', 'day' as const],
    ['24. - 30. August', 'Vorherige Woche', 'Nächste Woche', 'standard' as const],
    ['August 2026', 'Vorheriger Monat', 'Nächster Monat', 'standard' as const],
  ])('labels and activates navigation for %s', (label, previousLabel, nextLabel, titleVariant) => {
    const onNext = vi.fn();
    const onPrevious = vi.fn();
    const onToday = vi.fn();
    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(
        <CalendarPeriodNavigation
          label={label}
          nextLabel={nextLabel}
          onNext={onNext}
          onPrevious={onPrevious}
          onToday={onToday}
          previousLabel={previousLabel}
          tc={{ border: '#334155', text: '#f8fafc', tint: '#60a5fa' }}
          titleVariant={titleVariant}
          todayLabel="Heute"
        />
      );
    });

    const previous = tree.root.findByProps({ accessibilityLabel: previousLabel });
    const today = tree.root.findByProps({ accessibilityLabel: 'Heute' });
    const next = tree.root.findByProps({ accessibilityLabel: nextLabel });
    expect(previous.props.accessibilityRole).toBe('button');
    expect(today.props.accessibilityRole).toBe('button');
    expect(next.props.accessibilityRole).toBe('button');
    expect(tree.root.findByProps({ children: label })).toBeDefined();

    act(() => {
      previous.props.onPress();
      today.props.onPress();
      next.props.onPress();
    });

    expect(onPrevious).toHaveBeenCalledOnce();
    expect(onToday).toHaveBeenCalledOnce();
    expect(onNext).toHaveBeenCalledOnce();
  });
});
