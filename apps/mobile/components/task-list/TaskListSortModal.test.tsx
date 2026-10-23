import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TaskListSortModal } from './TaskListSortModal';
import { TASK_LIST_SORT_OPTIONS } from '@mindwtr/core';

let timeEstimatesEnabled = true;
let prioritiesEnabled = true;

// The real core filter, fed the store's feature flags.
vi.mock('@mindwtr/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mindwtr/core')>();
  return {
    ...actual,
    useTaskStore: (selector: (state: unknown) => unknown) => selector({
      settings: { features: { timeEstimates: timeEstimatesEnabled, priorities: prioritiesEnabled } },
    }),
  };
});

vi.mock('react-native', () => ({
  Modal: ({ children, visible }: any) => (visible ? React.createElement('div', null, children) : null),
  StyleSheet: { create: (styles: any) => styles },
  Pressable: ({ onPress, testID, style, ...props }: any) =>
    React.createElement('button', { ...props, 'data-testid': testID, onClick: onPress }, props.children),
  Text: ({ style, ...props }: any) => React.createElement('span', props, props.children),
  View: ({ style, ...props }: any) => React.createElement('div', props, props.children),
}));

const themeColors = { border: '#d1d5db', cardBg: '#ffffff', filterBg: '#f3f4f6', text: '#111827' };

const renderModal = (sortBy: 'default' | 'timeEstimate' = 'default') => renderToStaticMarkup(
  <TaskListSortModal
    onClose={vi.fn()}
    onSelect={vi.fn()}
    sortBy={sortBy}
    sortOptions={TASK_LIST_SORT_OPTIONS}
    t={(key: string) => key}
    themeColors={themeColors}
    visible
  />,
);

describe('TaskListSortModal time-estimate sort (#1107)', () => {
  beforeEach(() => {
    timeEstimatesEnabled = true;
    prioritiesEnabled = true;
  });

  it('lists the time-estimate sort while the feature is on', () => {
    expect(renderModal()).toContain('sort-option-timeEstimate');
  });

  it('hides it while the feature is off', () => {
    timeEstimatesEnabled = false;
    const markup = renderModal();
    expect(markup).not.toContain('sort-option-timeEstimate');
    // The rest of the roster is untouched.
    expect(markup).toContain('sort-option-title');
  });

  // Callers now pass the RESOLVED sort (resolveTaskListSortBy turns a stored
  // 'timeEstimate' into 'default' while the feature is off), so the selected row
  // is always one of the listed options and no escape hatch is needed (#1107).
  it('shows the default row selected for a stored time-estimate sort with the feature off', () => {
    timeEstimatesEnabled = false;
    const markup = renderModal('default');
    expect(markup).not.toContain('sort-option-timeEstimate');
    expect(markup).toContain('sort-option-default');
  });
});

describe('TaskListSortModal priority sort (#1415)', () => {
  beforeEach(() => {
    timeEstimatesEnabled = true;
    prioritiesEnabled = true;
  });

  it('lists Priority, labelled with Focus\'s filters.priority key, while Priorities is on', () => {
    const markup = renderModal();
    expect(markup).toContain('data-testid="sort-option-priority"><span>filters.priority</span>');
  });

  it('hides it while Priorities is off', () => {
    prioritiesEnabled = false;
    const markup = renderModal();
    expect(markup).not.toContain('sort-option-priority');
    expect(markup).toContain('sort-option-timeEstimate');
  });
});
