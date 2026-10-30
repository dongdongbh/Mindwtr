import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { getBulkMoveStatusOptions, TaskListBulkBar } from './TaskListBulkBar';

vi.mock('@/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ tint: '#3b82f6', onTint: '#ffffff' }),
}));
vi.mock('@/hooks/use-theme-tokens', () => ({
  useThemeTokens: () => ({ isMaterial: false, roles: null, shape: { large: 16 } }),
}));

vi.mock('react-native', () => ({
  ActivityIndicator: ({ color, size }: any) => React.createElement('span', { 'data-activity': size, style: { color } }),
  ScrollView: ({ children, contentContainerStyle, horizontal, showsHorizontalScrollIndicator, style, ...props }: any) =>
    React.createElement('div', props, children),
  StyleSheet: { create: (styles: any) => styles },
  Text: ({ accessibilityLabel, accessibilityRole, ...props }: any) =>
    React.createElement('span', { ...props, 'aria-label': accessibilityLabel, role: accessibilityRole }, props.children),
  TouchableOpacity: ({ accessibilityLabel, accessibilityRole, accessibilityState, activeOpacity, disabled, onPress, style, testID, ...props }: any) =>
    React.createElement('button', {
      ...props,
      'aria-label': accessibilityLabel,
      'aria-selected': accessibilityState?.selected,
      'data-testid': testID,
      disabled: disabled || accessibilityState?.disabled,
      role: accessibilityRole,
      onClick: onPress,
    }, props.children),
  View: ({ accessibilityLabel, accessibilityRole, style, ...props }: any) =>
    React.createElement('div', { ...props, 'aria-label': accessibilityLabel, role: accessibilityRole }, props.children),
}));

vi.mock('lucide-react-native', () => ({
  ClipboardCheck: () => React.createElement('span', { 'data-icon': 'clipboard-check' }),
  X: () => React.createElement('span', { 'data-icon': 'x' }),
}));

const themeColors = {
  border: '#d1d5db',
  cardBg: '#ffffff',
  filterBg: '#f3f4f6',
  onTint: '#ffffff',
  secondaryText: '#6b7280',
  text: '#111827',
  tint: '#2563eb',
};

const t = (key: string) => ({
  'bulk.addTag': 'Add tag',
  'bulk.delete': 'Delete',
  'common.delete': 'Delete',
  'bulk.exitSelect': 'Done',
  'bulk.moveTo': 'Move to',
  'bulk.selectRange': 'Range',
  'bulk.selectRangeActive': 'Pick end',
  'bulk.selected': 'selected',
  'common.loading': 'Loading',
  'projects.reorderTasks': 'Reorder',
  'status.archived': 'Archived',
  'status.done': 'Done',
  'status.inbox': 'Inbox',
  'status.next': 'Next',
  'status.reference': 'Reference',
  'status.someday': 'Someday',
  'status.waiting': 'Waiting',
}[key] ?? key);

const renderBulkBar = (overrides: Partial<React.ComponentProps<typeof TaskListBulkBar>> = {}) => renderToStaticMarkup(
  <TaskListBulkBar
    bulkActionLabel=""
    bulkActionLoading={false}
    handleBatchDelete={vi.fn()}
    handleBatchMove={vi.fn()}
    hasSelection
    onExitSelectionMode={vi.fn()}
    onOpenTagModal={vi.fn()}
    onToggleRangeSelectMode={vi.fn()}
    rangeSelectMode={false}
    selectedCount={2}
    t={t}
    themeColors={themeColors}
    {...overrides}
  />
);

describe('TaskListBulkBar', () => {
  it('offers the Reorder shortcut only for a list that supplies it and waits for pending bulk work', () => {
    expect(renderBulkBar()).not.toContain('aria-label="Reorder"');
    expect(renderBulkBar({ onReorder: vi.fn() })).toContain('aria-label="Reorder"');
    expect(renderBulkBar({ onReorder: vi.fn(), bulkActionLoading: true }))
      .toContain('aria-label="Reorder" data-testid="task-list-reorder-shortcut" disabled');
  });

  it('offers Archived only when moving completed tasks', () => {
    expect(getBulkMoveStatusOptions('done')).toEqual([
      'inbox',
      'next',
      'waiting',
      'someday',
      'reference',
      'archived',
    ]);
    expect(getBulkMoveStatusOptions('next')).not.toContain('archived');
  });

  it('shows a compact range toggle when bulk selection is active', () => {
    const html = renderBulkBar();

    expect(html).toContain('aria-label="Range"');
    expect(html).toContain('data-testid="task-list-range-select-toggle"');
    expect(html).toContain('Range');
  });

  it('exposes range mode as a selected toggle state', () => {
    const html = renderBulkBar({ rangeSelectMode: true });

    expect(html).toContain('aria-label="Pick end"');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('Pick end');
  });

  it('keeps a selection-mode exit affordance inside the bulk bar', () => {
    const html = renderBulkBar();

    expect(html).toContain('aria-label="Done"');
  });



  it('renders provided move statuses in order without adding hidden statuses', () => {
    const html = renderBulkBar({ statusOptions: ['next', 'done', 'reference'] } as any);

    expect(html).not.toContain('Move to Inbox');
    expect(html.indexOf('Move to Done')).toBeLessThan(html.indexOf('Move to Reference'));
  });

  it('labels bulk organize generically because it is shared outside Inbox', () => {
    const html = renderBulkBar({ onOpenOrganize: vi.fn() });

    expect(html).toContain('aria-label="Bulk organize"');
    expect(html).not.toContain('Bulk organize Inbox');
  });

  it('offers the section move only when a list supplies it, with a focusable button', () => {
    const html = renderBulkBar({ onMoveToSection: vi.fn() });
    expect(html).toContain('aria-label="Move to section…"');
    expect(html).toContain('Move to section…');
    expect(renderBulkBar()).not.toContain('aria-label="Move to section…"');
    expect(renderBulkBar({ onMoveToSection: vi.fn(), hasSelection: false }))
      .toContain('aria-label="Move to section…" disabled');
  });
});
