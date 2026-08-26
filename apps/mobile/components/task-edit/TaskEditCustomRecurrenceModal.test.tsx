import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { TouchableOpacity } from 'react-native';
import { describe, expect, it, vi } from 'vitest';

import type { ThemeColors } from '@/hooks/use-theme-colors';
import { TaskEditCustomRecurrenceModal } from './TaskEditCustomRecurrenceModal';

vi.mock('../../lib/use-android-keyboard-inset', () => ({
    useAndroidKeyboardInset: () => 0,
}));

const styles = new Proxy({}, { get: () => ({}) }) as Record<string, never>;
const tc = {
    tint: '#2563eb',
    filterBg: '#f1f5f9',
    border: '#cbd5e1',
    onTint: '#ffffff',
    secondaryText: '#64748b',
    text: '#0f172a',
    cardBg: '#ffffff',
    inputBg: '#f8fafc',
} as unknown as ThemeColors;

const renderModal = (customMonthDays: number[], toggleCustomMonthDay = vi.fn()) => {
    let tree!: renderer.ReactTestRenderer;
    act(() => {
        tree = renderer.create(
            <TaskEditCustomRecurrenceModal
                customInterval={1}
                customMode="date"
                customMonthDays={customMonthDays}
                customOrdinal="1"
                customWeekday="MO"
                onClose={vi.fn()}
                onSave={vi.fn()}
                recurrenceWeekdayButtons={[{ key: 'MO', label: 'Mån' }]}
                recurrenceWeekdayLabels={{ MO: 'Mån' }}
                setCustomInterval={vi.fn()}
                setCustomMode={vi.fn()}
                toggleCustomMonthDay={toggleCustomMonthDay}
                setCustomOrdinal={vi.fn()}
                setCustomWeekday={vi.fn()}
                styles={styles}
                t={(key) => key === 'recurrence.lastDay'
                    ? 'Sista dagen'
                    : key === 'recurrence.lastDayOfMonth'
                        ? 'Sista dagen i månaden'
                        : key}
                tc={tc}
                visible
            />,
        );
    });
    return tree;
};

describe('TaskEditCustomRecurrenceModal', () => {
    it('uses the translated last-day label while selected state conveys removal', () => {
        const toggleCustomMonthDay = vi.fn();
        const tree = renderModal([-1, 15], toggleCustomMonthDay);
        const toggle = tree.root.findAllByType(TouchableOpacity).find(
            (node) => node.props.accessibilityLabel === 'Sista dagen i månaden',
        );

        expect(toggle).toBeTruthy();
        expect(toggle?.props.accessibilityState).toEqual({ selected: true });
        act(() => toggle?.props.onPress());
        expect(toggleCustomMonthDay).toHaveBeenCalledWith(-1);
    });
});
