import React from 'react';
import { Platform, TextInput } from 'react-native';
import { configureDateFormatting } from '@mindwtr/core';
import renderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CompletedAtPicker } from './completed-at-picker';

vi.mock('@react-native-community/datetimepicker', () => ({
    __esModule: true,
    default: (props: any) => React.createElement('DateTimePicker', props),
}));

const originalPlatformOs = Platform.OS;

describe('CompletedAtPicker', () => {
    afterEach(() => {
        Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatformOs });
        configureDateFormatting();
    });

    it('shows the configured Android date and time and retains duration through timestamp corrections', () => {
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
        configureDateFormatting({ language: 'en', dateFormat: 'ymd', timeFormat: '24h' });
        const onConfirm = vi.fn();
        const onCancel = vi.fn();
        const initial = new Date(2026, 6, 14, 18, 30);
        const selected = new Date(2026, 6, 20, 21, 45);
        const corrected = new Date(2026, 6, 22, 8, 30);

        let tree!: renderer.ReactTestRenderer;
        act(() => {
            tree = renderer.create(
                <CompletedAtPicker
                    initialValue={initial.toISOString()}
                    initialTimeSpentMinutes={15}
                    showTimeSpent
                    onCancel={onCancel}
                    onConfirm={onConfirm}
                    t={(key) => ({
                        'common.cancel': 'Cancel',
                        'common.save': 'Save',
                        'task.completedAtPromptTitle': 'Completion time',
                        'taskEdit.timeSpentLabel': 'Time Spent',
                        'taskEdit.timeSpentPlaceholder': 'minutes',
                    })[key] ?? key}
                    tc={{
                        cardBg: '#111',
                        inputBg: '#222',
                        border: '#333',
                        text: '#fff',
                        secondaryText: '#aaa',
                        tint: '#3b82f6',
                    } as any}
                />
            );
        });

        const picker = () => tree.root.findByType('DateTimePicker' as any);
        const select = (value: Date) => act(() => picker().props.onChange({ type: 'set' }, value));
        const timestamp = () => tree.root.findByProps({ testID: 'completed-at-timestamp' });
        select(selected);
        expect(picker().props.is24Hour).toBe(true);
        select(selected);

        expect(onConfirm).not.toHaveBeenCalled();
        expect(timestamp().props.accessibilityLabel).toContain('2026-07-20 21:45');
        expect(tree.root.findByType(TextInput).props.value).toBe('15');
        act(() => tree.root.findByType(TextInput).props.onChangeText('45 minutes'));
        act(() => timestamp().props.onPress());
        expect(picker().props.value).toEqual(selected);
        select(corrected);
        act(() => picker().props.onChange({ type: 'dismissed' }));
        expect(onCancel).not.toHaveBeenCalled();
        expect(timestamp().props.accessibilityLabel).toContain('2026-07-20 21:45');
        expect(tree.root.findByType(TextInput).props.value).toBe('45');
        act(() => timestamp().props.onPress());
        select(corrected);
        select(corrected);
        expect(timestamp().props.accessibilityLabel).toContain('2026-07-22 08:30');
        expect(tree.root.findByType(TextInput).props.value).toBe('45');
        expect(onConfirm).not.toHaveBeenCalled();
        act(() => {
            tree.root.findByProps({ accessibilityLabel: 'Save' }).props.onPress();
        });

        expect(onConfirm).toHaveBeenCalledWith(corrected.toISOString(), 45);
        act(() => tree.unmount());
    });

    it('preserves an untouched iOS instant and normalizes the optional minutes on confirm', () => {
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
        const onConfirm = vi.fn();
        const initial = '2026-07-14T18:30:45.123Z';
        let tree!: renderer.ReactTestRenderer;
        act(() => {
            tree = renderer.create(<CompletedAtPicker initialValue={initial} initialTimeSpentMinutes={17}
                showTimeSpent onCancel={vi.fn()} onConfirm={onConfirm} t={(key) => key}
                tc={{ cardBg: '#111', inputBg: '#222', border: '#333', text: '#fff',
                    secondaryText: '#aaa', tint: '#3b82f6' } as any} />);
        });
        const input = tree.root.findByType(TextInput);
        expect(input.props.value).toBe('17');
        act(() => tree.root.findByProps({ accessibilityLabel: 'Save' }).props.onPress());
        expect(onConfirm).toHaveBeenLastCalledWith(initial, 17);
        act(() => input.props.onChangeText('100001 minutes'));
        act(() => tree.root.findByProps({ accessibilityLabel: 'Save' }).props.onPress());
        expect(onConfirm).toHaveBeenLastCalledWith(initial, 100_000);
        act(() => input.props.onChangeText(''));
        act(() => tree.root.findByProps({ accessibilityLabel: 'Save' }).props.onPress());
        expect(onConfirm).toHaveBeenLastCalledWith(initial, undefined);
    });
});
