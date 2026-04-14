import { act, render, waitFor } from '@testing-library/react';
import type { Task } from '@mindwtr/core';
import { useTaskStore } from '@mindwtr/core';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LanguageProvider } from '../../contexts/language-context';
import { KeybindingProvider } from '../../contexts/keybinding-context';
import { useUiStore } from '../../store/ui-store';
import { restoreDeletedTasksWithFeedback } from './list/useListSelection';
import { ListView, reportArchivedTaskQueryFailure } from './ListView';

const reportErrorMock = vi.hoisted(() => vi.fn());

vi.mock('../../lib/report-error', () => ({
  reportError: reportErrorMock,
}));

const initialTaskState = useTaskStore.getState();
const initialUiState = useUiStore.getState();
const now = new Date().toISOString();

const makeTask = (id: string, overrides: Partial<Task> = {}): Task => ({
  id,
  title: `Task ${id}`,
  status: 'next',
  tags: [],
  contexts: [],
  createdAt: now,
  updatedAt: now,
  ...overrides,
});

const renderStaticListView = (statusFilter: 'inbox' | 'done', title: string) =>
  renderToStaticMarkup(
    <LanguageProvider>
      <KeybindingProvider currentView={statusFilter} onNavigate={() => {}}>
        <ListView title={title} statusFilter={statusFilter} />
      </KeybindingProvider>
    </LanguageProvider>
  );

const renderListView = (statusFilter: 'next' | 'done' | 'archived' = 'next', title = 'Next') =>
  render(
    <LanguageProvider>
      <KeybindingProvider currentView={statusFilter} onNavigate={() => {}}>
        <ListView title={title} statusFilter={statusFilter} />
      </KeybindingProvider>
    </LanguageProvider>
  );

describe('ListView', () => {
  beforeEach(() => {
    reportErrorMock.mockReset();

    useTaskStore.setState(initialTaskState, true);
    useUiStore.setState(initialUiState, true);

    useTaskStore.setState({
      tasks: [],
      projects: [],
      areas: [],
      settings: {},
      lastDataChangeAt: 0,
    });
    useUiStore.setState((state) => ({
      ...state,
      listFilters: {
        tokens: [],
        priorities: [],
        estimates: [],
        open: false,
      },
      listOptions: {
        showDetails: false,
        nextGroupBy: 'none',
      },
      projectView: {
        selectedProjectId: null,
      },
      editingTaskId: null,
      expandedTaskIds: {},
    }));
  });

  it('renders the view title', () => {
    const html = renderStaticListView('inbox', 'Inbox');
    expect(html).toContain('Inbox');
  });

  it('does not render local search input in inbox view', () => {
    const html = renderStaticListView('inbox', 'Inbox');
    expect(html).not.toContain('data-view-filter-input');
  });

  it('renders local search input in done view', () => {
    const html = renderStaticListView('done', 'Done');
    expect(html).toContain('data-view-filter-input');
  });

  it('does not show filtering feedback after a background task refresh settles', async () => {
    useTaskStore.setState({
      tasks: [makeTask('1')],
      lastDataChangeAt: 1,
    });

    const { queryByText } = renderListView();
    expect(queryByText('Filtering...')).not.toBeInTheDocument();

    act(() => {
      useTaskStore.setState({
        tasks: [makeTask('1'), makeTask('2')],
        lastDataChangeAt: 2,
      });
    });

    await waitFor(() => {
      expect(queryByText('Filtering...')).not.toBeInTheDocument();
    });
  });

  it('applies token filters from the UI store', async () => {
    useTaskStore.setState({
      tasks: [
        makeTask('1', { title: 'Work task', contexts: ['@work'] }),
        makeTask('2', { title: 'Home task', contexts: ['@home'] }),
      ],
      lastDataChangeAt: 1,
    });

    const { queryByText } = renderListView();

    act(() => {
      useUiStore.getState().setListFilters({ tokens: ['@work'] });
    });

    await waitFor(() => {
      expect(queryByText('Work task')).toBeInTheDocument();
      expect(queryByText('Home task')).not.toBeInTheDocument();
    });
  });

  it('does not scroll back to the selected row after a background refresh', async () => {
    const scrollIntoViewMock = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoViewMock,
    });

    useTaskStore.setState({
      tasks: [makeTask('1'), makeTask('2')],
      lastDataChangeAt: 1,
    });

    const { queryByText } = renderListView();

    await waitFor(() => {
      expect(queryByText('Task 2')).toBeInTheDocument();
    });

    scrollIntoViewMock.mockClear();

    act(() => {
      useTaskStore.setState({
        tasks: [makeTask('1'), makeTask('2'), makeTask('3')],
        lastDataChangeAt: 2,
      });
    });

    await waitFor(() => {
      expect(queryByText('Task 3')).toBeInTheDocument();
    });

    expect(scrollIntoViewMock).not.toHaveBeenCalled();
  });

  it('shows an error toast when loading archived tasks fails', () => {
    const showToast = vi.fn();

    reportArchivedTaskQueryFailure(new Error('disk read failed'), showToast);

    expect(reportErrorMock).toHaveBeenCalledWith('Failed to load archived tasks', expect.any(Error));
    expect(showToast).toHaveBeenCalledWith('Failed to load archived tasks', 'error');
  });

  it('shows an error toast when a batch undo restore returns a failed result', async () => {
    const showToast = vi.fn();

    await restoreDeletedTasksWithFeedback(
      ['1', '2'],
      vi.fn()
        .mockResolvedValueOnce({ success: true })
        .mockResolvedValueOnce({ success: false, error: 'Task not found' }),
      showToast,
    );

    expect(reportErrorMock).toHaveBeenCalledWith('Failed to restore deleted tasks', expect.any(Error));
    expect(showToast).toHaveBeenCalledWith('Task not found', 'error');
  });

  it('does not show an error toast when batch undo restore succeeds', async () => {
    const showToast = vi.fn();

    await restoreDeletedTasksWithFeedback(
      ['1', '2'],
      vi.fn().mockResolvedValue({ success: true }),
      showToast,
    );

    expect(reportErrorMock).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();
  });
});
