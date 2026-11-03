import { act, fireEvent, render, waitFor, within } from '@testing-library/react';
import type { Area, Project, Task } from '@mindwtr/core';
import { useTaskStore } from '@mindwtr/core';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LanguageProvider } from '../../contexts/language-context';
import { KeybindingProvider } from '../../contexts/keybinding-context';
import { useUiStore } from '../../store/ui-store';
import { restoreDeletedTasksWithFeedback } from './list/useTaskSelection';
import { ListView, reportArchivedTaskQueryFailure } from './ListView';
import { selectToolbarOption } from '../../test/toolbar-select';
import { expectScrolledEndGap } from '../../test/list-end-gap';

const reportErrorMock = vi.hoisted(() => vi.fn());
const selectionInputs = vi.hoisted(() => ({ scrollCallbacks: [] as unknown[] }));

vi.mock('./list/useListSelection', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./list/useListSelection')>();
  return {
    ...actual,
    useListSelection: (options: Parameters<typeof actual.useListSelection>[0]) => {
      selectionInputs.scrollCallbacks.push(options.scrollToVirtualIndex);
      return actual.useListSelection(options);
    },
  };
});

vi.mock('../../lib/report-error', () => ({
  reportError: reportErrorMock,
}));

const initialTaskState = useTaskStore.getState();
const initialUiState = useUiStore.getState();
const now = new Date().toISOString();
const referenceViewStateStorageKey = 'mindwtr:view:reference:v1';

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

const renderListView = (statusFilter: 'inbox' | 'next' | 'waiting' | 'someday' | 'done' | 'archived' | 'reference' = 'next', title = 'Next') =>
  render(
    <LanguageProvider>
      <KeybindingProvider currentView={statusFilter} onNavigate={() => {}}>
        <ListView title={title} statusFilter={statusFilter} />
      </KeybindingProvider>
    </LanguageProvider>
  );

describe('ListView', () => {
  it('opens a Waiting task when double-clicking the bottom of its row', () => {
    useTaskStore.setState({
      _allTasks: [makeTask('waiting-row', { status: 'waiting', assignedTo: 'Maya' })],
      lastDataChangeAt: 1,
    });
    const view = renderListView('waiting', 'Waiting');
    const row = view.getByText('Task waiting-row').closest('[data-task-id]');
    expect(row).not.toBeNull();
    fireEvent.doubleClick(row!);
    expect(view.getByDisplayValue('Task waiting-row')).toBeInTheDocument();
  });

  it('keeps the quiet Waiting person selector functional and resettable', () => {
    useTaskStore.setState({
      _allTasks: [
        makeTask('waiting-tom', { status: 'waiting', assignedTo: 'Tom' }),
        makeTask('waiting-maya', { status: 'waiting', assignedTo: 'Maya' }),
      ],
      lastDataChangeAt: 1,
    });
    const view = renderListView('waiting', 'Waiting');
    const who = view.getByRole('combobox', { name: 'Who? (optional)' });
    expect(who.className).toContain('bg-transparent');
    expect(who.className).toContain('appearance-none');
    expect(who.className).toContain('focus-visible:ring-2');
    fireEvent.change(who, { target: { value: 'Tom' } });
    expect(view.getByText('Task waiting-tom')).toBeInTheDocument();
    expect(view.queryByText('Task waiting-maya')).not.toBeInTheDocument();
    fireEvent.change(who, { target: { value: '' } });
    expect(view.getByText('Task waiting-maya')).toBeInTheDocument();
  });

  it('keeps Inbox global while other lists retain the selected area', () => {
    const work: Area = {
      id: 'area-work', name: 'Work', color: '#2563eb', order: 0, createdAt: now, updatedAt: now,
    };
    const personal: Area = { ...work, id: 'area-personal', name: 'Personal', order: 1 };
    const personalProject: Project = {
      id: 'project-personal', title: 'Personal project', status: 'active', color: '#16a34a',
      order: 0, tagIds: [], areaId: personal.id, createdAt: now, updatedAt: now,
    };
    const parkedProject: Project = { ...personalProject, id: 'project-parked', status: 'someday' };
    const tasks = [
      makeTask('work-inbox', { title: 'Work inbox', status: 'inbox', areaId: work.id }),
      makeTask('personal-inbox', { title: 'Personal inbox', status: 'inbox', areaId: personal.id }),
      makeTask('inherited-inbox', { title: 'Inherited inbox', status: 'inbox', projectId: personalProject.id }),
      makeTask('unassigned-inbox', { title: 'Unassigned inbox', status: 'inbox' }),
      makeTask('parked-inbox', { title: 'Parked inbox', status: 'inbox', projectId: parkedProject.id }),
      makeTask('deleted-inbox', { title: 'Deleted inbox', status: 'inbox', deletedAt: now }),
      makeTask('work-next', { title: 'Work next', status: 'next', areaId: work.id }),
      makeTask('personal-next', { title: 'Personal next', status: 'next', areaId: personal.id }),
    ];
    const filters = {
      areaId: work.id,
      areaIds: [work.id],
      excludedAreaIds: [personal.id, '__none__'],
    };
    useTaskStore.setState({
      _allAreas: [work, personal],
      _allProjects: [personalProject, parkedProject],
      _allTasks: tasks,
      settings: { filters },
      lastDataChangeAt: 1,
    });

    const inbox = renderListView('inbox', 'Inbox');
    expect(inbox.getByText('All areas')).toBeInTheDocument();
    expect(inbox.getByText('Work inbox')).toBeInTheDocument();
    expect(inbox.getByText('Personal inbox')).toBeInTheDocument();
    expect(inbox.getByText('Inherited inbox')).toBeInTheDocument();
    expect(inbox.getByText('Unassigned inbox')).toBeInTheDocument();
    expect(inbox.queryByText('Parked inbox')).not.toBeInTheDocument();
    expect(inbox.queryByText('Deleted inbox')).not.toBeInTheDocument();
    expect(inbox.getByRole('button', { name: /Process Inbox \(4\)/i })).toBeInTheDocument();
    expect(useTaskStore.getState().settings.filters).toEqual(filters);
    inbox.unmount();

    const next = renderListView('next', 'Next');
    expect(next.getByText('Work next')).toBeInTheDocument();
    expect(next.queryByText('Personal next')).not.toBeInTheDocument();
  });

  it('keeps the reveal scroll callback stable across non-data rerenders', () => {
    const tasks = Array.from({ length: 200 }, (_, index) => makeTask(String(index)));
    useTaskStore.setState({ _allTasks: tasks, tasks, lastDataChangeAt: 1 });
    const screen = (title: string) => (
      <LanguageProvider>
        <KeybindingProvider currentView="next" onNavigate={() => {}}>
          <ListView title={title} statusFilter="next" />
        </KeybindingProvider>
      </LanguageProvider>
    );
    const view = render(screen('Next'));
    const before = selectionInputs.scrollCallbacks[selectionInputs.scrollCallbacks.length - 1];
    expect(before).toBeTypeOf('function');
    view.rerender(screen('Next actions'));
    expect(selectionInputs.scrollCallbacks[selectionInputs.scrollCallbacks.length - 1]).toBe(before);
  });

  beforeEach(() => {
    selectionInputs.scrollCallbacks = [];
    reportErrorMock.mockReset();
    window.localStorage.removeItem(referenceViewStateStorageKey);
    window.localStorage.removeItem('mindwtr:view:list:next:v1');

    useTaskStore.setState(initialTaskState, true);
    useUiStore.setState(initialUiState, true);

    useTaskStore.setState({
      _allTasks: [],
      _allProjects: [],
      _allAreas: [],
      settings: {},
      lastDataChangeAt: 0,
    });
    useUiStore.setState((state) => ({
      ...state,
      listFilters: {
        criteria: {},
        open: false,
      },
      listOptions: {
        showDetails: false,
        focusGroupBy: 'none', inboxGroupBy: 'none', nextGroupBy: 'none',
        waitingGroupBy: 'none', somedayGroupBy: 'none',
        referenceGroupBy: 'area', doneGroupBy: 'none', archivedGroupBy: 'none',
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

  it('omits redundant Details in Reference while preserving its preview and other list controls', () => {
    useTaskStore.setState({
      _allTasks: [makeTask('reference', {
        title: 'Reference note',
        status: 'reference',
        description: 'Always-visible reference preview',
      })],
      lastDataChangeAt: 1,
    });

    const reference = renderListView('reference', 'Reference');
    const referenceSort = reference.getByRole('combobox', { name: 'Sort' });
    const referenceGroup = reference.getByRole('combobox', { name: 'Group' });

    expect(reference.queryByRole('button', { name: 'Show details' })).not.toBeInTheDocument();
    expect(reference.queryByRole('button', { name: 'Hide details' })).not.toBeInTheDocument();
    expect(reference.getByText('Always-visible reference preview')).toBeInTheDocument();
    expect(referenceSort).toHaveClass('bg-card');
    expect(referenceGroup).toHaveClass('bg-card');
    expect(referenceSort).not.toHaveClass('bg-primary/10');
    expect(referenceGroup).not.toHaveClass('bg-primary/10');
    expect(useUiStore.getState().listOptions.showDetails).toBe(false);
    reference.unmount();

    const next = renderListView('next', 'Next');
    expect(next.getByRole('button', { name: 'Show details' })).toBeInTheDocument();
  });

  it('keeps fresh Someday grouping neutral and highlights selected section grouping', () => {
    useUiStore.setState((state) => ({
      listOptions: { ...state.listOptions, somedayGroupBy: 'none' },
    }));
    const view = renderListView('someday', 'Someday');
    const trigger = view.getByRole('combobox', { name: 'Group' });

    expect(trigger).toHaveClass('bg-card');
    expect(trigger).not.toHaveClass('bg-primary/10');

    act(() => {
      useUiStore.getState().setListOptions({ somedayGroupBy: 'viewSection' });
    });
    expect(trigger).toHaveClass('bg-primary/10');

    act(() => {
      useUiStore.getState().setListOptions({ somedayGroupBy: 'none' });
    });
    expect(trigger).toHaveClass('bg-card');
  });

  it('keeps global density rendering while omitting density from the toolbar', () => {
    useTaskStore.setState({
      _allTasks: [makeTask('compact', { title: 'Compact task', status: 'next' })],
      settings: { appearance: { density: 'compact' } },
      lastDataChangeAt: 1,
    });
    const view = renderListView('next', 'Next');

    expect(view.getByText('Compact task')).toHaveClass('text-sm');
    expect(view.queryByRole('button', { name: /Density:/ })).not.toBeInTheDocument();
    expect(view.queryByText('Density')).not.toBeInTheDocument();
  });

  it('ends the scroller with the shared end gap, not with viewport padding (#977)', () => {
    const { container } = renderListView('next', 'Next');
    expectScrolledEndGap(container);
  });

  it('does not render local search input in inbox view', () => {
    const html = renderStaticListView('inbox', 'Inbox');
    expect(html).not.toContain('data-view-filter-input');
  });

  it('uses a compact one-line quick-add hint in the inbox list footer', () => {
    const { getByRole, getByText, queryByPlaceholderText, queryByText } = renderListView('inbox', 'Inbox');

    expect(queryByPlaceholderText(/Add Task/i)).toBeInTheDocument();
    expect(getByText('Try: Call mom /due:tomorrow 5pm @phone #family')).toBeInTheDocument();
    expect(getByRole('button', { name: 'Quick Add syntax help' })).toHaveAttribute(
      'title',
      expect.stringContaining('/start:<when>')
    );
    expect(queryByText(/Quick add supports/)).not.toBeInTheDocument();
  });

  it('trades the syntax hint for a live read-out of what the draft parses to', () => {
    const { getByPlaceholderText, getByTestId, queryByText } = renderListView('inbox', 'Inbox');

    act(() => {
      fireEvent.change(getByPlaceholderText(/Add Task/i), {
        target: { value: 'call mom @phone #family' },
      });
    });

    const preview = getByTestId('quick-add-preview');
    expect(preview).toHaveTextContent('@phone');
    expect(preview).toHaveTextContent('#family');
    expect(queryByText('Try: Call mom /due:tomorrow 5pm @phone #family')).not.toBeInTheDocument();
  });

  it('finds an archived bare context in Inbox Quick Add while blank choices stay visible-only', () => {
    useTaskStore.setState({
      _allTasks: [
        makeTask('active', { status: 'inbox', contexts: ['@active-only'] }),
        makeTask('archived', { status: 'archived', contexts: ['Seasonal Planning'] }),
        makeTask('deleted', { status: 'next', contexts: ['@deleted-only'], deletedAt: now }),
      ],
      lastDataChangeAt: 1,
    });
    const view = renderListView('inbox', 'Inbox');
    const input = view.getByPlaceholderText(/Add Task/i);
    fireEvent.change(input, { target: { value: '@' } });
    expect(view.queryByRole('option', { name: '@Seasonal Planning' })).not.toBeInTheDocument();
    fireEvent.change(input, { target: { value: '@Seas' } });
    expect(view.getByRole('option', { name: '@Seasonal Planning' })).toBeInTheDocument();
    fireEvent.change(input, { target: { value: 'Plan @Seasonal Planning' } });
    expect(view.getByTestId('quick-add-preview')).toHaveTextContent('@Seasonal Planning');
    fireEvent.change(input, { target: { value: '@dele' } });
    expect(view.queryByRole('option', { name: '@deleted-only' })).not.toBeInTheDocument();
  });

  it('keeps Mind Sweep open when the first capture populates an empty inbox', async () => {
    const addTask = vi.fn(async (title: string, initialProps?: Partial<Task>) => {
      const task = makeTask('captured', {
        title,
        status: initialProps?.status ?? 'inbox',
      });
      useTaskStore.setState({
        tasks: [task],
        _allTasks: [task],
        lastDataChangeAt: 1,
      });
      return { success: true, task };
    });
    useTaskStore.setState({ addTask, tasks: [], _allTasks: [] });

    const { getByRole } = renderListView('inbox', 'Inbox');
    fireEvent.click(getByRole('button', { name: /mind sweep/i }));

    const introDialog = getByRole('dialog');
    fireEvent.click(within(introDialog).getByRole('button', { name: /start/i }));
    const input = within(introDialog).getByRole('textbox');
    fireEvent.change(input, { target: { value: 'First captured thought' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(addTask).toHaveBeenCalledWith('First captured thought', { status: 'inbox' });
      expect(getByRole('dialog')).toBeInTheDocument();
      expect(within(getByRole('dialog')).getByText('First captured thought')).toBeInTheDocument();
    });
  });

  it.each([
    ['next', 'Next'],
    ['waiting', 'Waiting'],
    ['someday', 'Someday'],
    ['reference', 'Reference'],
  ] as const)('does not render the inline quick-add composer in the %s view', (statusFilter, title) => {
    const { queryByPlaceholderText, queryByText } = renderListView(statusFilter, title);

    expect(queryByPlaceholderText(/Add Task/i)).not.toBeInTheDocument();
    expect(queryByText('Try: Call mom /due:tomorrow 5pm @phone #family')).not.toBeInTheDocument();
  });

  it.each([
    ['next', 'Next'],
    ['waiting', 'Waiting'],
    ['someday', 'Someday'],
    ['reference', 'Reference'],
  ] as const)('does not show a contextual empty-state add action in the %s view', (statusFilter, title) => {
    const { queryByRole } = renderListView(statusFilter, title);

    expect(queryByRole('button', { name: 'Add Task' })).not.toBeInTheDocument();
  });

  it('renders local search input in done view', () => {
    const html = renderStaticListView('done', 'Done');
    expect(html).toContain('data-view-filter-input');
  });

  it('labels the Done search chip with Search instead of the input placeholder', () => {
    useTaskStore.setState({ _allTasks: [makeTask('done', { status: 'done', title: 'Milk' })], lastDataChangeAt: 1 });
    const view = renderListView('done', 'Done');
    fireEvent.change(view.container.querySelector('[data-view-filter-input]')!, { target: { value: 'Milk' } });
    expect(view.getAllByText('Search: Milk').length).toBeGreaterThan(0);
  });

  it('keeps a legacy completed sort in Done without leaking it after navigation', () => {
    useTaskStore.setState({
      settings: { taskSortBy: 'completed' },
      _allTasks: [
        makeTask('next-z', { title: 'Zulu first', status: 'next', order: 0 }),
        makeTask('next-a', { title: 'Alpha second', status: 'next', order: 1 }),
      ],
      lastDataChangeAt: 1,
    });

    const next = renderListView('next', 'Next');
    expect(next.getByRole('combobox', { name: 'Sort' })).toHaveTextContent('Default');
    expect(next.container.textContent?.indexOf('Zulu first'))
      .toBeLessThan(next.container.textContent?.indexOf('Alpha second') ?? -1);
    next.unmount();

    useTaskStore.setState({
      _allTasks: [
        makeTask('done-old', {
          title: 'Older',
          status: 'done',
          completedAt: new Date(2026, 6, 26, 12).toISOString(),
        }),
        makeTask('done-new', {
          title: 'Newer',
          status: 'done',
          completedAt: new Date(2026, 6, 27, 12).toISOString(),
        }),
      ],
      lastDataChangeAt: 2,
    });
    const done = renderListView('done', 'Done');
    expect(done.getByRole('combobox', { name: 'Sort' })).toHaveTextContent('Completion date');
    expect(done.container.textContent?.indexOf('Newer'))
      .toBeLessThan(done.container.textContent?.indexOf('Older') ?? -1);
  });

  it('persists a separate Done sort without changing the synced list preference', () => {
    useTaskStore.setState({
      settings: { taskSortBy: 'title' },
      _allTasks: [makeTask('done', { status: 'done' })],
      lastDataChangeAt: 1,
    });

    const done = renderListView('done', 'Done');
    selectToolbarOption('Sort', 'Completion date', done);

    expect(useUiStore.getState().listOptions.doneSortBy).toBe('completed');
    expect(useTaskStore.getState().settings.taskSortBy).toBe('title');
    done.unmount();

    useTaskStore.setState({
      _allTasks: [makeTask('next', { status: 'next' })],
      lastDataChangeAt: 2,
    });
    const next = renderListView('next', 'Next');
    expect(next.getByRole('combobox', { name: 'Sort' })).toHaveTextContent('Title');
  });

  it('moves completion-date groups across local midnight', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(2026, 6, 27, 23, 59, 59, 900));
      useTaskStore.setState({
        _allTasks: [
          makeTask('done-today', {
            title: 'Finished today',
            status: 'done',
            completedAt: new Date(2026, 6, 27, 12).toISOString(),
          }),
        ],
        lastDataChangeAt: 1,
      });
      useUiStore.setState((state) => ({
        ...state,
        listOptions: {
          ...state.listOptions,
          doneGroupBy: 'completedDate',
        },
      }));

      const done = renderListView('done', 'Done');
      expect(done.getByText('Today')).toBeInTheDocument();
      await act(async () => {
        vi.advanceTimersByTime(200);
        await Promise.resolve();
      });
      expect(done.getByText('Yesterday')).toBeInTheDocument();
      done.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['waiting', 'Waiting'],
    ['someday', 'Someday'],
  ] as const)('opens the default quick-add pane from the %s view using a', (statusFilter, title) => {
    const quickAddListener = vi.fn();
    window.addEventListener('mindwtr:quick-add', quickAddListener);

    renderListView(statusFilter, title);

    fireEvent.keyDown(window, { key: 'a' });

    expect(quickAddListener).toHaveBeenCalledTimes(1);
    expect((quickAddListener.mock.calls[0]?.[0] as CustomEvent).detail).toBeUndefined();

    window.removeEventListener('mindwtr:quick-add', quickAddListener);
  });

  it('does not leak a Someday task from a Someday project into the Someday task list', () => {
    const workArea = {
      id: 'area-work',
      name: 'Work',
      color: '#3b82f6',
      order: 0,
      createdAt: now,
      updatedAt: now,
    };
    const somedayProject = {
      id: 'project-someday',
      title: 'Someday ideas',
      status: 'someday' as const,
      color: '#8b5cf6',
      order: 0,
      tagIds: [],
      areaId: workArea.id,
      createdAt: now,
      updatedAt: now,
    };
    const somedayTask = makeTask('someday-project-task', {
      title: 'Try a pottery class',
      status: 'someday',
      projectId: somedayProject.id,
    });

    useTaskStore.setState({
      _allAreas: [workArea],
      _allProjects: [somedayProject],
      _allTasks: [somedayTask],
      lastDataChangeAt: 1,
      settings: { filters: { areaId: workArea.id } },
    });
    useUiStore.setState((state) => ({
      ...state,
      listOptions: { ...state.listOptions, somedayGroupBy: 'project' },
    }));

    const { queryByText } = renderListView('someday', 'Someday');

    expect(queryByText('Try a pottery class')).not.toBeInTheDocument();
  });

  it.each(['someday', 'waiting'] as const)('renders collapsible, area-filtered %s projects with open and reactivate actions', async (status) => {
    const workArea = {
      id: 'area-work',
      name: 'Work',
      color: '#3b82f6',
      order: 0,
      createdAt: now,
      updatedAt: now,
    };
    const personalArea = {
      ...workArea,
      id: 'area-personal',
      name: 'Personal',
      order: 1,
    };
    const workProject = {
      id: 'project-work-someday',
      title: 'Plan Japan trip',
      status,
      color: '#8b5cf6',
      order: 0,
      tagIds: [],
      areaId: workArea.id,
      createdAt: now,
      updatedAt: now,
    };
    const personalProject = {
      ...workProject,
      id: 'project-personal-someday',
      title: 'Remodel kitchen',
      areaId: personalArea.id,
    };
    const updateProject = vi.fn(async () => ({ success: true }));

    useTaskStore.setState({
      _allAreas: [workArea, personalArea],
      _allProjects: [workProject, personalProject],
      _allTasks: [],
      lastDataChangeAt: 1,
      settings: { filters: { areaId: workArea.id } },
      updateProject,
    });

    const view = renderListView(status, status);

    expect(view.getByRole('button', { name: 'Projects: Plan Japan trip' })).toBeInTheDocument();
    expect(view.queryByText('Remodel kitchen')).not.toBeInTheDocument();

    const disclosure = view.getByRole('button', { name: 'Projects (1)' });
    expect(disclosure).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(disclosure);
    expect(disclosure).toHaveAttribute('aria-expanded', 'false');
    expect(view.queryByRole('button', { name: 'Projects: Plan Japan trip' })).not.toBeInTheDocument();
    expect(updateProject).not.toHaveBeenCalled();
    fireEvent.click(disclosure);
    expect(disclosure).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(view.getByRole('button', { name: 'Projects: Plan Japan trip' }));
    expect(useUiStore.getState().projectView.selectedProjectId).toBe(workProject.id);

    fireEvent.click(view.getByRole('button', { name: 'Reactivate' }));
    await waitFor(() => {
      expect(updateProject).toHaveBeenCalledWith(workProject.id, { status: 'active' });
    });
  });

  it('renders orphaned Someday assignments under No section without an inline admin panel', () => {
    const known = makeTask('known-section', {
      title: 'Read DDIA',
      status: 'someday',
      viewSectionIds: { someday: 'books' },
    });
    const orphan = makeTask('orphan-section', {
      title: 'Learn pottery',
      status: 'someday',
      viewSectionIds: { someday: 'heading-from-another-device' },
    });
    const orphanBeforeRender = JSON.stringify(orphan);
    const updateTask = vi.fn(async () => ({ success: true }));
    useTaskStore.setState({
      _allTasks: [known, orphan],
      _allProjects: [],
      lastDataChangeAt: 1,
      settings: {
        gtd: {
          viewSections: {
            someday: [{ id: 'books', title: 'Books to read', order: 0 }],
          },
        },
      },
      updateTask,
    });
    useUiStore.setState((state) => ({
      ...state,
      listOptions: { ...state.listOptions, somedayGroupBy: 'viewSection' },
    }));

    const view = renderListView('someday', 'Someday');

    expect(view.getAllByText('Books to read')).toHaveLength(1);
    expect(view.queryByText('Someday sections')).not.toBeInTheDocument();
    expect(view.getByText('No section')).toBeInTheDocument();
    expect(view.getByText('Learn pottery')).toBeInTheDocument();
    expect(JSON.stringify(orphan)).toBe(orphanBeforeRender);
    expect(updateTask).not.toHaveBeenCalled();

    expect(updateTask).not.toHaveBeenCalled();
    expect(orphan.viewSectionIds?.someday).toBe('heading-from-another-device');
  });

  it('keeps future-start inbox tasks visible while hiding future-start next actions', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-04-16T10:00:00Z'));

      useTaskStore.setState({
        _allTasks: [
          makeTask('inbox-future', {
            title: 'Future inbox task',
            status: 'inbox',
            startTime: '2026-04-20',
          }),
          makeTask('next-future', {
            title: 'Future next task',
            status: 'next',
            startTime: '2026-04-20',
          }),
        ],
        lastDataChangeAt: 1,
      });

      const inbox = renderListView('inbox', 'Inbox');
      expect(inbox.queryByText('Future inbox task')).toBeInTheDocument();
      inbox.unmount();

      const next = renderListView('next', 'Next');
      expect(next.queryByText('Future next task')).not.toBeInTheDocument();
      next.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reveals Next actions at midnight and at their explicit start time', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-04-16T23:59:30'));
      useTaskStore.setState({
        _allTasks: [
          makeTask('tomorrow-date', {
            title: 'Tomorrow date task',
            status: 'next',
            startTime: '2026-04-17',
          }),
          makeTask('tomorrow-time', {
            title: 'Tomorrow timed task',
            status: 'next',
            startTime: '2026-04-17T00:01',
          }),
        ],
        lastDataChangeAt: 1,
      });

      const next = renderListView('next', 'Next');
      expect(next.queryByText('Tomorrow date task')).not.toBeInTheDocument();
      expect(next.queryByText('Tomorrow timed task')).not.toBeInTheDocument();

      await act(async () => {
        vi.advanceTimersByTime(30_100);
        await Promise.resolve();
      });
      expect(next.getByText('Tomorrow date task')).toBeInTheDocument();
      expect(next.queryByText('Tomorrow timed task')).not.toBeInTheDocument();

      await act(async () => {
        vi.advanceTimersByTime(60_100);
        await Promise.resolve();
      });
      expect(next.getByText('Tomorrow timed task')).toBeInTheDocument();
      next.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it('always defers a due-only recurring chore out of Next, with no notice or Show control', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-07-14T10:00:00Z'));


      useTaskStore.setState({
        _allTasks: [
          makeTask('chore', {
            title: 'Descale the kettle',
            status: 'next',
            dueDate: '2026-09-14',
            recurrence: 'monthly',
          }),
          makeTask('actionable', { title: 'Email the plumber', status: 'next' }),
        ],
        settings: { appearance: { showFutureStarts: true } },
        lastDataChangeAt: 1,
      });

      const deferred = renderListView('next', 'Next');
      expect(deferred.queryByText('Email the plumber')).toBeInTheDocument();
      expect(deferred.queryByText('Descale the kettle')).not.toBeInTheDocument();
      expect(deferred.queryByText(/hidden \(future start\)/)).not.toBeInTheDocument();
      expect(deferred.queryByText(/future-start task(s)? shown/)).not.toBeInTheDocument();
      deferred.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not show filtering feedback after a background task refresh settles', async () => {
    useTaskStore.setState({
      _allTasks: [makeTask('1')],
      lastDataChangeAt: 1,
    });

    const { queryByText } = renderListView();
    expect(queryByText('Filtering...')).not.toBeInTheDocument();

    act(() => {
      useTaskStore.setState({
        _allTasks: [makeTask('1'), makeTask('2')],
        lastDataChangeAt: 2,
      });
    });

    await waitFor(() => {
      expect(queryByText('Filtering...')).not.toBeInTheDocument();
    });
  });

  it('defaults reference tasks to area grouping', () => {
    useTaskStore.setState({
      _allAreas: [{ id: 'area-1', name: 'Work', color: '#2563eb', order: 0, createdAt: now, updatedAt: now }],
      _allTasks: [
        makeTask('1', { title: 'Work reference', status: 'reference', areaId: 'area-1' }),
        makeTask('2', { title: 'Loose reference', status: 'reference' }),
      ],
      lastDataChangeAt: 1,
    });

    const { getAllByText, getByRole, queryByText } = renderListView('reference', 'Reference');

    expect(getByRole('combobox', { name: 'Group' })).toHaveTextContent('Area');
    expect(getAllByText('Work').length).toBeGreaterThanOrEqual(1);
    expect(queryByText('No Area')).toBeInTheDocument();
  });

  it('searches Reference title and description by every whitespace-separated term', async () => {
    useTaskStore.setState({
      _allTasks: [
        makeTask('1', {
          title: 'Printer handbook',
          description: 'Default admin password',
          status: 'reference',
        }),
        makeTask('2', {
          title: 'Printer warranty',
          description: 'Renewal details',
          status: 'reference',
        }),
      ],
      lastDataChangeAt: 1,
    });
    useUiStore.setState((state) => ({
      ...state,
      listOptions: { ...state.listOptions, referenceGroupBy: 'none' },
    }));

    const view = renderListView('reference', 'Reference');
    fireEvent.change(view.getByRole('textbox', { name: /Search/ }), {
      target: { value: 'printer ADMIN' },
    });

    await waitFor(() => {
      expect(view.getByText('Printer handbook')).toBeInTheDocument();
      expect(view.queryByText('Printer warranty')).not.toBeInTheDocument();
    });
  });

  it('keeps non-Reference local search limited to the title', async () => {
    useTaskStore.setState({
      _allTasks: [makeTask('1', { title: 'Printer handbook', description: 'Default admin password' })],
      lastDataChangeAt: 1,
    });

    const view = renderListView('next', 'Next');
    fireEvent.change(view.getByRole('textbox', { name: /Search/ }), {
      target: { value: 'admin' },
    });

    await waitFor(() => {
      expect(view.queryByText('Printer handbook')).not.toBeInTheDocument();
    });
  });

  it('includes archived-project references only when requested and excludes tombstones', async () => {
    const batchMoveTasks = vi.fn(async () => ({ success: true }));
    const activeProject: Project = {
      id: 'project-active',
      title: 'Active project',
      status: 'active',
      color: '#2563eb',
      order: 0,
      tagIds: [],
      createdAt: now,
      updatedAt: now,
    };
    const archivedProject: Project = {
      ...activeProject,
      id: 'project-archived',
      title: 'Archived project',
      status: 'archived',
      cancelledAt: now,
    };
    const deletedProject: Project = {
      ...archivedProject,
      id: 'project-deleted',
      title: 'Deleted project',
      deletedAt: now,
    };
    useTaskStore.setState({
      _allProjects: [activeProject, archivedProject, deletedProject],
      _allTasks: [
        makeTask('active', { title: 'Active note', status: 'reference', projectId: activeProject.id, tags: ['#active'] }),
        makeTask('archived', { title: 'Historical note', status: 'reference', projectId: archivedProject.id, tags: ['#history'] }),
        makeTask('deleted-project', { title: 'Deleted project note', status: 'reference', projectId: deletedProject.id }),
        makeTask('deleted-task', { title: 'Deleted task note', status: 'reference', deletedAt: now }),
        makeTask('purged-task', { title: 'Purged task note', status: 'reference', purgedAt: now }),
      ],
      batchMoveTasks,
      lastDataChangeAt: 1,
    });
    useUiStore.setState((state) => ({
      ...state,
      listFilters: { ...state.listFilters, open: true },
      listOptions: { ...state.listOptions, referenceGroupBy: 'none' },
    }));

    const view = renderListView('reference', 'Reference');
    const includeArchived = view.getByRole('checkbox', { name: 'Include archived projects' });

    expect(includeArchived).not.toBeChecked();
    expect(view.getByText('Active note')).toBeInTheDocument();
    expect(view.queryByText('Historical note')).not.toBeInTheDocument();
    expect(view.queryByRole('button', { name: /^#history/ })).not.toBeInTheDocument();

    fireEvent.click(includeArchived);
    fireEvent.click(view.getByRole('button', { name: 'Contexts & tags' }));

    await waitFor(() => {
      expect(view.getByText('Historical note')).toBeInTheDocument();
      expect(view.getByRole('button', { name: /^#history/ })).toBeInTheDocument();
    });
    expect(view.queryByText('Deleted project note')).not.toBeInTheDocument();
    expect(view.queryByText('Deleted task note')).not.toBeInTheDocument();
    expect(view.queryByText('Purged task note')).not.toBeInTheDocument();

    fireEvent.click(view.getByRole('button', { name: 'Select' }));
    const activeRow = view.getByText('Active note').closest('[data-task-id]') as HTMLElement;
    const historicalRow = view.getByText('Historical note').closest('[data-task-id]') as HTMLElement;
    expect(within(activeRow).getByRole('checkbox', { name: 'Select task' })).not.toBeChecked();
    expect(within(historicalRow).queryByRole('checkbox', { name: 'Select task' })).not.toBeInTheDocument();
    expect(within(historicalRow).getByRole('button', { name: /Toggle task details/ })).not.toBeDisabled();

    fireEvent.click(view.getByRole('button', { name: 'Select All' }));
    expect(within(activeRow).getByRole('checkbox', { name: 'Select task' })).toBeChecked();
    fireEvent.change(view.getByRole('combobox', { name: 'Status' }), {
      target: { value: 'next' },
    });

    await waitFor(() => {
      expect(batchMoveTasks).toHaveBeenCalledWith(['active'], 'next');
    });
    expect(useTaskStore.getState()._allTasks.find((task) => task.id === 'archived')).toMatchObject({
      status: 'reference',
      projectId: archivedProject.id,
    });
    expect(useTaskStore.getState()._allProjects.find((project) => project.id === archivedProject.id)).toMatchObject({
      status: 'archived',
    });

    fireEvent.click(includeArchived);

    await waitFor(() => {
      expect(view.queryByText('Historical note')).not.toBeInTheDocument();
      expect(view.queryByRole('checkbox', { name: 'Select task' })).not.toBeInTheDocument();
    });
  });

  it('drops a selected Reference when its project becomes archived while the row stays visible', async () => {
    const activeProject: Project = {
      id: 'project-active',
      title: 'Active project',
      status: 'active',
      color: '#2563eb',
      order: 0,
      tagIds: [],
      createdAt: now,
      updatedAt: now,
    };
    useTaskStore.setState({
      _allProjects: [activeProject],
      _allTasks: [makeTask('reference', {
        title: 'Changing project note',
        status: 'reference',
        projectId: activeProject.id,
      })],
      lastDataChangeAt: 1,
    });
    useUiStore.setState((state) => ({
      ...state,
      listFilters: { ...state.listFilters, open: true },
      listOptions: { ...state.listOptions, referenceGroupBy: 'none' },
    }));

    const view = renderListView('reference', 'Reference');
    fireEvent.click(view.getByRole('checkbox', { name: 'Include archived projects' }));
    fireEvent.click(view.getByRole('button', { name: 'Select' }));
    fireEvent.click(view.getByRole('checkbox', { name: 'Select task' }));
    expect(view.getByRole('combobox', { name: 'Status' })).toBeInTheDocument();

    act(() => {
      useTaskStore.setState({
        _allProjects: [{ ...activeProject, status: 'archived', updatedAt: new Date().toISOString() }],
        lastDataChangeAt: 2,
      });
    });

    await waitFor(() => {
      expect(view.getByText('Changing project note')).toBeInTheDocument();
      expect(view.queryByRole('checkbox', { name: 'Select task' })).not.toBeInTheDocument();
      expect(view.queryByRole('combobox', { name: 'Status' })).not.toBeInTheDocument();
    });
  });

  it('does not count criteria this view never applies as active filters', async () => {
    useTaskStore.setState({
      _allTasks: [makeTask('plain', { title: 'Unprioritized task' })],
      lastDataChangeAt: 1,
    });
    useUiStore.setState((state) => ({
      ...state,
      listFilters: { criteria: { priority: ['high'] }, open: true },
    }));

    const view = renderListView('next', 'Next');


    await waitFor(() => expect(view.getByText('Unprioritized task')).toBeInTheDocument());
    expect(view.queryByText('No tasks match these filters.')).not.toBeInTheDocument();
    const summaryRow = view.getByText('1 tasks').parentElement as HTMLElement;
    expect(within(summaryRow).queryByText(/High/)).toBeNull();


    const chip = view.getByRole('button', { name: 'Remove filter: High' }).parentElement as HTMLElement;
    expect(chip.className).toContain('opacity-60');
    fireEvent.click(view.getByRole('button', { name: 'Remove filter: High' }));
    await waitFor(() => expect(useUiStore.getState().listFilters.criteria).not.toHaveProperty('priority'));
  });

  it('keeps the filtered empty state for criteria this view does apply', async () => {
    useTaskStore.setState({
      _allTasks: [makeTask('prioritized', { title: 'Urgent task', priority: 'urgent' })],
      lastDataChangeAt: 1,
    });
    useUiStore.setState((state) => ({
      ...state,
      listFilters: { criteria: { priority: ['high'] }, open: true },
    }));

    const view = renderListView('next', 'Next');

    await waitFor(() => expect(view.getByText('No tasks match these filters.')).toBeInTheDocument());
    expect(view.getByRole('button', { name: 'Remove filter: High' }).parentElement?.className)
      .not.toContain('opacity-60');
    const summaryRow = view.getByText('0 tasks').parentElement as HTMLElement;
    expect(within(summaryRow).getByText(/High/)).toBeInTheDocument();
  });

  it('masks context criteria in Reference without clearing them or disabling tag filters', async () => {
    useTaskStore.setState({
      _allTasks: [
        makeTask('kept', {
          title: 'Tagged reference',
          status: 'reference',
          contexts: ['@blocked'],
          tags: ['#reading'],
        }),
        makeTask('filtered', {
          title: 'Other reference',
          status: 'reference',
          contexts: ['@other'],
          tags: ['#other'],
        }),
      ],
      lastDataChangeAt: 1,
    });
    useUiStore.setState((state) => ({
      ...state,
      listFilters: {
        criteria: {
          contexts: ['@missing'],
          excludedContexts: ['@blocked'],
          tags: ['#reading'],
        },
        open: true,
      },
      listOptions: { ...state.listOptions, referenceGroupBy: 'none' },
    }));

    const view = renderListView('reference', 'Reference');

    await waitFor(() => {
      expect(view.getByText('Tagged reference')).toBeInTheDocument();
      expect(view.queryByText('Other reference')).not.toBeInTheDocument();
    });
    expect(view.getByText('@missing')).toBeInTheDocument();
    expect(view.getByText('@blocked')).toBeInTheDocument();
    fireEvent.click(view.getByRole('button', { name: 'Contexts & tags' }));
    await waitFor(() => {
      expect(view.getByRole('button', { name: '#reading' })).toHaveAttribute('aria-pressed', 'true');
    });
    expect(useUiStore.getState().listFilters.criteria).toMatchObject({
      contexts: ['@missing'],
      excludedContexts: ['@blocked'],
      tags: ['#reading'],
    });
  });

  it('virtualizes grouped rows beyond the threshold even with fewer unique tasks', () => {
    const tasks = Array.from({ length: 20 }, (_, index) => makeTask(`reference-${index}`, {
      title: `Reference ${index}`,
      status: 'reference',
      tags: ['#alpha', '#beta'],
    }));
    useTaskStore.setState({
      _allTasks: tasks,
      lastDataChangeAt: 1,
    });
    useUiStore.setState((state) => ({
      ...state,
      listOptions: {
        ...state.listOptions,
        referenceGroupBy: 'tag',
      },
    }));

    const { getByTestId } = renderListView('reference', 'Reference');

    expect(getByTestId('virtualized-task-list')).toHaveAttribute('data-grouped', 'true');
  });

  it('groups reference tasks by each tag when tag grouping is selected', () => {
    useTaskStore.setState({
      _allTasks: [
        makeTask('1', { title: 'Dual-tag reference', status: 'reference', tags: ['#alpha', '#beta'] }),
        makeTask('2', { title: 'Untagged reference', status: 'reference' }),
      ],
      lastDataChangeAt: 1,
    });
    useUiStore.setState((state) => ({
      ...state,
      listOptions: {
        ...state.listOptions,
        referenceGroupBy: 'tag',
      },
    }));

    const { getAllByText, queryByText } = renderListView('reference', 'Reference');

    expect(getAllByText('#alpha').length).toBeGreaterThanOrEqual(1);
    expect(getAllByText('#beta').length).toBeGreaterThanOrEqual(1);
    expect(queryByText('No tags')).toBeInTheDocument();
    expect(getAllByText('Dual-tag reference')).toHaveLength(2);
  });

  it('groups inbox tasks by each tag when tag grouping is selected', () => {
    useTaskStore.setState({
      _allTasks: [
        makeTask('1', { title: 'Dual-tag inbox', status: 'inbox', tags: ['#alpha', '#beta'] }),
        makeTask('2', { title: 'Untagged inbox', status: 'inbox' }),
      ],
      lastDataChangeAt: 1,
    });
    useUiStore.setState((state) => ({
      ...state,
      listOptions: {
        ...state.listOptions,
        inboxGroupBy: 'tag',
      },
    }));

    const { getAllByText, getByRole, queryByText } = renderListView('inbox', 'Inbox');

    expect(getByRole('combobox', { name: 'Group' })).toHaveTextContent('Tags');
    expect(queryByText('#alpha')).toBeInTheDocument();
    expect(queryByText('#beta')).toBeInTheDocument();
    expect(queryByText('No tags')).toBeInTheDocument();
    expect(getAllByText('Dual-tag inbox')).toHaveLength(2);
  });

  it('keeps each list grouping to its own view (#1063)', () => {
    useTaskStore.setState({
      _allTasks: [makeTask('1', { title: 'Inbox item', status: 'inbox', contexts: ['@work'] })],
      lastDataChangeAt: 1,
    });

    const inbox = renderListView('inbox', 'Inbox');
    selectToolbarOption('Group', 'Context', inbox);

    expect(useUiStore.getState().listOptions.inboxGroupBy).toBe('context');
    expect(useUiStore.getState().listOptions.nextGroupBy).toBe('none');
    expect(useUiStore.getState().listOptions.focusGroupBy).toBe('none');
    inbox.unmount();

    const next = renderListView('next', 'Next');
    expect(next.getByRole('combobox', { name: 'Group' })).toHaveTextContent('No grouping');
  });

  it('groups reference tasks by context when context grouping is selected', () => {
    useTaskStore.setState({
      _allTasks: [
        makeTask('1', { title: 'Work reference', status: 'reference', contexts: ['@work'] }),
        makeTask('2', { title: 'Home reference', status: 'reference', contexts: ['@home'] }),
        makeTask('3', { title: 'Loose reference', status: 'reference' }),
      ],
      lastDataChangeAt: 1,
    });
    useUiStore.setState((state) => ({
      ...state,
      listOptions: {
        ...state.listOptions,
        referenceGroupBy: 'context',
      },
    }));

    const { getByRole, queryByText } = renderListView('reference', 'Reference');

    expect(getByRole('combobox', { name: 'Group' })).toHaveTextContent('Context');
    expect(queryByText('@home')).toBeInTheDocument();
    expect(queryByText('@work')).toBeInTheDocument();
    expect(queryByText('No context')).toBeInTheDocument();
  });

  it('persists collapsed reference groups by grouping mode', () => {
    useTaskStore.setState({
      _allTasks: [
        makeTask('1', { title: 'Work reference', status: 'reference', contexts: ['@work'] }),
        makeTask('2', { title: 'Home reference', status: 'reference', contexts: ['@home'] }),
      ],
      lastDataChangeAt: 1,
    });
    useUiStore.setState((state) => ({
      ...state,
      listOptions: {
        ...state.listOptions,
        referenceGroupBy: 'context',
      },
    }));

    const firstRender = renderListView('reference', 'Reference');
    const workGroup = firstRender.getByRole('button', { name: /@work\s*1/i });

    fireEvent.click(workGroup);

    expect(firstRender.getByRole('button', { name: /@work\s*1/i })).toHaveAttribute('aria-expanded', 'false');
    expect(firstRender.queryByText('Work reference')).not.toBeInTheDocument();
    expect(firstRender.getByText('Home reference')).toBeInTheDocument();

    const persisted = JSON.parse(window.localStorage.getItem(referenceViewStateStorageKey) ?? '{}') as {
      collapsedGroups?: Record<string, string[]>;
    };
    expect(persisted.collapsedGroups?.context).toEqual(['context:@work']);
    expect(persisted.collapsedGroups?.tag ?? []).toEqual([]);

    selectToolbarOption('Group', 'Tags', firstRender);
    expect(firstRender.getByRole('button', { name: /No tags\s*2/i })).toHaveAttribute('aria-expanded', 'true');

    selectToolbarOption('Group', 'Context', firstRender);
    firstRender.unmount();

    const secondRender = renderListView('reference', 'Reference');
    expect(secondRender.getByRole('button', { name: /@work\s*1/i })).toHaveAttribute('aria-expanded', 'false');
    expect(secondRender.queryByText('Work reference')).not.toBeInTheDocument();
    expect(secondRender.getByText('Home reference')).toBeInTheDocument();
  });


  it('expands the collapsed group holding a task sent here by global search', () => {
    window.localStorage.removeItem('mindwtr:view:list:done:v1');
    useTaskStore.setState({
      _allTasks: [
        makeTask('1', { title: 'Work done', status: 'done', contexts: ['@work'], completedAt: now }),
        makeTask('2', { title: 'Home done', status: 'done', contexts: ['@home'], completedAt: now }),
      ],
      lastDataChangeAt: 1,
    });
    useUiStore.setState((state) => ({
      ...state,
      listOptions: {
        ...state.listOptions,
        doneGroupBy: 'context',
      },
    }));

    const view = renderListView('done', 'Done');
    fireEvent.click(view.getByRole('button', { name: /@work\s*1/i }));
    expect(view.queryByText('Work done')).not.toBeInTheDocument();

    act(() => {
      useTaskStore.setState({ highlightTaskId: '1' });
    });

    expect(view.getByRole('button', { name: /@work\s*1/i })).toHaveAttribute('aria-expanded', 'true');
    expect(view.getByText('Work done')).toBeInTheDocument();
    window.localStorage.removeItem('mindwtr:view:list:done:v1');
  });

  it('keeps other collapsed groups folded when a highlighted task appears in more than one', () => {
    window.localStorage.removeItem('mindwtr:view:list:done:v1');
    useTaskStore.setState({
      _allTasks: [
        makeTask('1', {
          title: 'Dual-tag done',
          status: 'done',
          tags: ['#alpha', '#beta'],
          completedAt: now,
        }),
      ],
      lastDataChangeAt: 1,
    });
    useUiStore.setState((state) => ({
      ...state,
      listOptions: {
        ...state.listOptions,
        doneGroupBy: 'tag',
      },
    }));

    const view = renderListView('done', 'Done');
    const alpha = () => view.getByRole('button', { name: /#alpha\s*1/i });
    const beta = () => view.getByRole('button', { name: /#beta\s*1/i });
    fireEvent.click(alpha());
    fireEvent.click(beta());

    act(() => {
      useTaskStore.setState({ highlightTaskId: '1' });
    });

    expect([alpha(), beta()].filter((group) => group.getAttribute('aria-expanded') === 'true')).toHaveLength(1);
    expect(view.getAllByText('Dual-tag done')).toHaveLength(1);
    window.localStorage.removeItem('mindwtr:view:list:done:v1');
  });

  it('collapses groups on any status list, not just Reference (#963)', () => {
    useTaskStore.setState({
      _allTasks: [
        makeTask('1', { title: 'Work next', status: 'next', contexts: ['@work'] }),
        makeTask('2', { title: 'Home next', status: 'next', contexts: ['@home'] }),
      ],
      lastDataChangeAt: 1,
    });
    useUiStore.setState((state) => ({
      ...state,
      listOptions: {
        ...state.listOptions,
        nextGroupBy: 'context',
      },
    }));

    const firstRender = renderListView('next', 'Next');
    fireEvent.click(firstRender.getByRole('button', { name: /@work\s*1/i }));

    expect(firstRender.getByRole('button', { name: /@work\s*1/i })).toHaveAttribute('aria-expanded', 'false');
    expect(firstRender.queryByText('Work next')).not.toBeInTheDocument();
    expect(firstRender.getByText('Home next')).toBeInTheDocument();


    const persisted = JSON.parse(window.localStorage.getItem('mindwtr:view:list:next:v1') ?? '{}') as {
      collapsedGroups?: Record<string, string[]>;
    };
    expect(persisted.collapsedGroups?.context).toEqual(['context:@work']);

    firstRender.unmount();
    const secondRender = renderListView('next', 'Next');
    expect(secondRender.queryByText('Work next')).not.toBeInTheDocument();
  });

  it('collapses expanded task details when page details are turned off', async () => {
    const expandedTask = makeTask('1', {
      title: 'Expanded task',
      description: 'Expanded task note',
    });
    useTaskStore.setState({
      _allTasks: [expandedTask],
      lastDataChangeAt: 1,
    });
    useUiStore.setState((state) => ({
      ...state,
      listOptions: {
        ...state.listOptions,
        showDetails: true,
      },
      expandedTaskIds: { '1': true },
    }));

    const { getByRole, queryByText } = renderListView();

    expect(queryByText('Expanded task note')).toBeInTheDocument();

    fireEvent.click(getByRole('button', { name: /^hide details$/i }));

    await waitFor(() => {
      expect(queryByText('Expanded task note')).not.toBeInTheDocument();
      expect(useUiStore.getState().listOptions.showDetails).toBe(false);
      expect(useUiStore.getState().expandedTaskIds).toEqual({});
    });
  });

  it('applies token filters from the UI store', async () => {
    useTaskStore.setState({
      _allTasks: [
        makeTask('1', { title: 'Work task', contexts: ['@work'] }),
        makeTask('2', { title: 'Home task', contexts: ['@home'] }),
      ],
      lastDataChangeAt: 1,
    });

    const { queryByText } = renderListView();

    act(() => {
      useUiStore.getState().setListFilters({ criteria: { contexts: ['@work'] } });
    });

    await waitFor(() => {
      expect(queryByText('Work task')).toBeInTheDocument();
      expect(queryByText('Home task')).not.toBeInTheDocument();
    });
  });

  it('cycles a Filters panel chip to excluded and subtracts matching tasks (#982)', async () => {
    useTaskStore.setState({
      _allTasks: [
        makeTask('1', { title: 'Computer task', contexts: ['@computer'] }),
        makeTask('2', { title: 'Errand task', contexts: ['@errands'] }),
      ],
      lastDataChangeAt: 1,
    });

    const { queryByText } = renderListView();
    act(() => {
      useUiStore.getState().setListFilters({ open: true });
    });
    const panel = () => within(document.getElementById('list-filters-panel') as HTMLElement);

    fireEvent.click(panel().getByRole('button', { name: 'Contexts & tags' }));
    fireEvent.click(panel().getByRole('button', { name: /^@computer/ }));
    await waitFor(() => {
      expect(queryByText('Computer task')).toBeInTheDocument();
      expect(queryByText('Errand task')).not.toBeInTheDocument();
    });


    fireEvent.click(panel().getByRole('button', { name: /^@computer/ }));
    await waitFor(() => {
      expect(queryByText('Computer task')).not.toBeInTheDocument();
      expect(queryByText('Errand task')).toBeInTheDocument();
    });
    expect(useUiStore.getState().listFilters.criteria.excludedContexts).toEqual(['@computer']);
    expect(panel().getByRole('button', { name: '@computer (Excluded)' })).toHaveAttribute('aria-pressed', 'mixed');


    fireEvent.click(panel().getByRole('button', { name: '@computer (Excluded)' }));
    await waitFor(() => {
      expect(queryByText('Computer task')).toBeInTheDocument();
      expect(queryByText('Errand task')).toBeInTheDocument();
    });
    expect(useUiStore.getState().listFilters.criteria).not.toHaveProperty('excludedContexts');
  });

  it('offers a parent context filter and keeps it clearable after its task completes', async () => {
    const tasks = [
      makeTask('tool', { title: 'Tool task', contexts: ['@tools/excavator'] }),
      makeTask('home', { title: 'Home task', contexts: ['@home'] }),
    ];
    useTaskStore.setState({ _allTasks: tasks, lastDataChangeAt: 1 });
    const view = renderListView();
    act(() => useUiStore.getState().setListFilters({ open: true }));
    const panel = () => within(document.getElementById('list-filters-panel') as HTMLElement);
    fireEvent.click(panel().getByRole('button', { name: 'Contexts & tags' }));
    fireEvent.click(panel().getByRole('button', { name: /^@tools(?:\s|$)/ }));
    expect(view.getByText('Tool task')).toBeInTheDocument();
    expect(view.queryByText('Home task')).not.toBeInTheDocument();

    act(() => useTaskStore.setState({
      _allTasks: tasks.map((task) => task.id === 'tool' ? { ...task, status: 'done' as const } : task),
      lastDataChangeAt: 2,
    }));
    expect(panel().getByRole('button', { name: /^@tools(?:\s|$)/ })).toHaveAttribute('aria-pressed', 'true');
    expect(view.queryByText('Home task')).not.toBeInTheDocument();
    fireEvent.click(panel().getByRole('button', { name: /^@tools(?:\s|$)/ }));
    fireEvent.click(panel().getByRole('button', { name: /^@tools(?:\s|$)/ }));
    expect(useUiStore.getState().listFilters.criteria).not.toHaveProperty('contexts');
    expect(view.getByText('Home task')).toBeInTheDocument();
  });

  it('selects and clears all visible tasks from the shared list toolbar', async () => {
    useTaskStore.setState({
      _allTasks: [
        makeTask('1', { title: 'First visible task' }),
        makeTask('2', { title: 'Second visible task' }),
      ],
      lastDataChangeAt: 1,
    });

    const { getAllByRole, getByRole } = renderListView();

    fireEvent.click(getByRole('button', { name: 'Select' }));
    fireEvent.click(getByRole('button', { name: 'Select All' }));

    await waitFor(() => {
      expect(getAllByRole('checkbox', { name: 'Select task' }).map((checkbox) => (
        (checkbox as HTMLInputElement).checked
      ))).toEqual([true, true]);
    });

    fireEvent.click(getByRole('button', { name: 'Clear' }));

    expect(getAllByRole('checkbox', { name: 'Select task' }).map((checkbox) => (
      (checkbox as HTMLInputElement).checked
    ))).toEqual([false, false]);
  });

  it('moves selected tasks to Trash immediately without a confirmation dialog', async () => {
    const batchDeleteTasks = vi.fn(async () => ({ success: true }));
    useTaskStore.setState({
      _allTasks: [
        makeTask('1', { title: 'First deletable task' }),
        makeTask('2', { title: 'Second deletable task' }),
      ],
      batchDeleteTasks,
      lastDataChangeAt: 1,
    });

    const { getByRole, queryByRole } = renderListView();

    fireEvent.click(getByRole('button', { name: 'Select' }));
    fireEvent.click(getByRole('button', { name: 'Select All' }));
    fireEvent.click(getByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      expect(batchDeleteTasks).toHaveBeenCalledWith(['1', '2']);
    });
    expect(queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('removes several picked tags from the selection and leaves untagged tasks alone', async () => {
    const batchUpdateTasks = vi.fn(async () => ({ success: true }));
    useTaskStore.setState({
      _allTasks: [
        makeTask('1', { title: 'First tagged task', tags: ['#ops', '#urgent', '#keep'] }),
        makeTask('2', { title: 'Second tagged task', tags: ['#urgent'] }),
        makeTask('3', { title: 'Untagged task', tags: ['#keep'] }),
      ],
      batchUpdateTasks,
      lastDataChangeAt: 1,
    });

    const { getByRole } = renderListView();

    fireEvent.click(getByRole('button', { name: 'Select' }));
    fireEvent.click(getByRole('button', { name: 'Select All' }));
    fireEvent.click(getByRole('button', { name: 'Remove tag' }));

    fireEvent.click(getByRole('button', { name: '#ops' }));
    fireEvent.click(getByRole('button', { name: '#urgent' }));
    fireEvent.click(getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(batchUpdateTasks).toHaveBeenCalledWith([
        { id: '1', updates: { tags: ['#keep'] } },
        { id: '2', updates: { tags: [] } },
      ]);
    });
  });

  it('disables Remove tag when the selection carries no tags', async () => {
    useTaskStore.setState({
      _allTasks: [makeTask('1', { title: 'Plain task' })],
      lastDataChangeAt: 1,
    });

    const { getByRole } = renderListView();

    fireEvent.click(getByRole('button', { name: 'Select' }));
    fireEvent.click(getByRole('button', { name: 'Select All' }));

    await waitFor(() => {
      expect(getByRole('button', { name: 'Remove tag' })).toBeDisabled();
    });
  });

  it('selects a visible range with shift-click in selection mode', async () => {
    useTaskStore.setState({
      _allTasks: [
        makeTask('1', { title: 'First range task' }),
        makeTask('2', { title: 'Second range task' }),
        makeTask('3', { title: 'Third range task' }),
        makeTask('4', { title: 'Fourth range task' }),
      ],
      lastDataChangeAt: 1,
    });

    const { getAllByRole, getByRole } = renderListView();

    fireEvent.click(getByRole('button', { name: 'Select' }));
    const checkboxes = getAllByRole('checkbox', { name: 'Select task' });
    fireEvent.click(checkboxes[0]);
    fireEvent.click(checkboxes[2], { shiftKey: true });

    await waitFor(() => {
      expect(getAllByRole('checkbox', { name: 'Select task' }).map((checkbox) => (
        (checkbox as HTMLInputElement).checked
      ))).toEqual([true, true, true, false]);
    });
  });

  it('does not scroll back to the selected row after a background refresh', async () => {
    const scrollIntoViewMock = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoViewMock,
    });

    useTaskStore.setState({
      _allTasks: [makeTask('1'), makeTask('2')],
      lastDataChangeAt: 1,
    });

    const { queryByText } = renderListView();

    await waitFor(() => {
      expect(queryByText('Task 2')).toBeInTheDocument();
    });

    scrollIntoViewMock.mockClear();

    act(() => {
      useTaskStore.setState({
        _allTasks: [makeTask('1'), makeTask('2'), makeTask('3')],
        lastDataChangeAt: 2,
      });
    });

    await waitFor(() => {
      expect(queryByText('Task 3')).toBeInTheDocument();
    });

    expect(scrollIntoViewMock).not.toHaveBeenCalled();
  });

  it('flashes and scrolls a freshly inline-added row into view (#916)', async () => {
    const scrollIntoViewMock = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoViewMock,
    });

    const addTask = vi.fn(async (title: string, props?: Partial<Task>) => {
      const task = makeTask('created', { title, status: props?.status ?? 'inbox' });
      useTaskStore.setState((state) => ({
        _allTasks: [...state._allTasks, task],
        lastDataChangeAt: (state.lastDataChangeAt ?? 0) + 1,
      }));
      return { success: true, id: 'created' };
    });
    useTaskStore.setState({ addTask, settings: { quickAddAutoClean: true } });

    const { container, getByRole, queryByText } = renderListView('inbox', 'Inbox');
    const input = getByRole('combobox', { name: 'Add Task' });
    await act(async () => {
      fireEvent.change(input, { target: { value: 'Buried inbox task' } });
    });
    const form = container.querySelector('form');
    await act(async () => {
      fireEvent.submit(form!);
    });

    await waitFor(() => {
      expect(queryByText('Buried inbox task')).toBeInTheDocument();
    });
    expect(useTaskStore.getState().highlightTaskId).toBe('created');
    await waitFor(() => {
      expect(scrollIntoViewMock).toHaveBeenCalled();
    });
  });

  it('does not scroll when the freshly inline-added task is filtered out of the view (#916)', async () => {
    const scrollIntoViewMock = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoViewMock,
    });

    const addTask = vi.fn(async (title: string, props?: Partial<Task>) => {
      const task = makeTask('created', { title, status: props?.status ?? 'inbox' });
      useTaskStore.setState((state) => ({
        _allTasks: [...state._allTasks, task],
        lastDataChangeAt: (state.lastDataChangeAt ?? 0) + 1,
      }));
      return { success: true, id: 'created' };
    });
    useTaskStore.setState({
      addTask,
      settings: { quickAddAutoClean: true },
      _allTasks: [makeTask('existing', { title: 'Filtered visible task', status: 'inbox', contexts: ['@work'] })],
      lastDataChangeAt: 1,
    });


    act(() => {
      useUiStore.getState().setListFilters({ criteria: { contexts: ['@work'] } });
    });

    const { container, getByRole, queryByText } = renderListView('inbox', 'Inbox');
    await waitFor(() => {
      expect(queryByText('Filtered visible task')).toBeInTheDocument();
    });

    scrollIntoViewMock.mockClear();

    const input = getByRole('combobox', { name: 'Add Task' });
    await act(async () => {
      fireEvent.change(input, { target: { value: 'Task without the filtered context' } });
    });
    const form = container.querySelector('form');
    await act(async () => {
      fireEvent.submit(form!);
    });

    await waitFor(() => {
      expect(useTaskStore.getState().highlightTaskId).toBe('created');
    });
    expect(queryByText('Task without the filtered context')).not.toBeInTheDocument();
    expect(scrollIntoViewMock).not.toHaveBeenCalled();
  });

  it('keeps the typed in-list capture text when the write is rejected', async () => {
    const addTask = vi.fn(async () => ({ success: false, error: 'Archived project' }));
    const showToast = vi.fn();
    useTaskStore.setState({ addTask });
    useUiStore.setState({ showToast });

    const { container, getByRole } = renderListView('inbox', 'Inbox');
    const input = getByRole('combobox', { name: 'Add Task' }) as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { value: 'Rejected capture' } });
    });
    const form = container.querySelector('form');
    await act(async () => {
      fireEvent.submit(form!);
    });

    expect(addTask).toHaveBeenCalledTimes(1);
    expect(input.value).toBe('Rejected capture');
    expect(showToast).toHaveBeenCalledWith('Failed to add task', 'error');
  });

  it('shows an error toast when loading archived tasks fails', () => {
    const showToast = vi.fn();

    reportArchivedTaskQueryFailure(new Error('disk read failed'), showToast, 'Kunde inte läsa in arkiverade uppgifter');


    expect(reportErrorMock).toHaveBeenCalledWith('Failed to load archived tasks', expect.any(Error));
    expect(showToast).toHaveBeenCalledWith('Kunde inte läsa in arkiverade uppgifter', 'error');
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

  it('uses the current area filter in the inline inbox composer when default area mode is active', async () => {
    const addTask = vi.fn().mockResolvedValue({ success: true });
    const areas = [
      {
        id: 'area-home',
        name: 'Home',
        color: '#10b981',
        order: 0,
        createdAt: '2026-07-01T00:00:00.000Z',
        updatedAt: '2026-07-01T00:00:00.000Z',
      },
      {
        id: 'area-work',
        name: 'Work',
        color: '#3b82f6',
        order: 1,
        createdAt: '2026-07-01T00:00:00.000Z',
        updatedAt: '2026-07-01T00:00:00.000Z',
      },
    ];

    useTaskStore.setState({
      addTask,
      areas,
      _allAreas: areas,
      settings: {
        quickAddAutoClean: true,
        filters: { areaId: 'area-work' },
        gtd: { defaultAreaMode: 'active', defaultAreaId: 'area-home' },
      },
    });

    const { container, getByRole } = renderListView('inbox', 'Inbox');
    const input = getByRole('combobox', { name: 'Add Task' });

    await act(async () => {
      fireEvent.change(input, { target: { value: 'Area filtered task' } });
    });

    const form = container.querySelector('form');
    expect(form).not.toBeNull();
    await act(async () => {
      fireEvent.submit(form!);
    });

    expect(addTask).toHaveBeenCalledWith('Area filtered task', expect.objectContaining({
      areaId: 'area-work',
      status: 'inbox',
    }));
  });

  it('applies trailing date NLP in the desktop inline inbox quick add', async () => {
    const addTask = vi.fn().mockResolvedValue({ success: true });
    const now = new Date('2026-04-16T10:00:00Z');
    vi.useFakeTimers();
    try {
      vi.setSystemTime(now);

      useTaskStore.setState({
        addTask,
        settings: { quickAddAutoClean: true },
      });

      const { container, getByRole } = renderListView('inbox', 'Inbox');

      const input = getByRole('combobox', { name: 'Add Task' });
      await act(async () => {
        fireEvent.change(input, { target: { value: 'Tax deadline — April 15' } });
      });

      const form = container.querySelector('form');
      expect(form).not.toBeNull();
      await act(async () => {
        fireEvent.submit(form!);
      });

      expect(addTask).toHaveBeenCalledWith('Tax deadline', expect.objectContaining({
        dueDate: '2027-04-15',
        status: 'inbox',
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not show the focus star in desktop inline quick add', () => {
    const { queryByRole } = renderListView('next', 'Next');

    expect(queryByRole('button', { name: /add to today's focus/i })).toBeNull();
  });

  it.each([
    ['done', 'Completed'],
    ['waiting', 'Waiting'],
    ['someday', 'Someday'],

    ['inbox', 'Inbox'],

    ['reference', 'Reference'],
  ] as const)('offers a Filters toggle in the %s toolbar', (statusFilter, title) => {
    const { getByRole } = renderListView(statusFilter, title);

    expect(getByRole('button', { name: 'Filters' })).toBeInTheDocument();
  });

  it('toggles the completed-list filter panel from the toolbar button', async () => {
    useTaskStore.setState({
      _allTasks: [makeTask('1', { title: 'Filed task', status: 'done', contexts: ['@work'] })],
      lastDataChangeAt: 1,
    });

    const { getByRole, queryByText } = renderListView('done', 'Completed');

    expect(queryByText('Contexts & tags')).not.toBeInTheDocument();

    fireEvent.click(getByRole('button', { name: 'Filters' }));
    await waitFor(() => {
      expect(queryByText('Contexts & tags')).toBeInTheDocument();
    });

    fireEvent.click(getByRole('button', { name: 'Filters' }));
    await waitFor(() => {
      expect(queryByText('Contexts & tags')).not.toBeInTheDocument();
    });
  });

  it('narrows the completed list when a context chip is selected in the panel', async () => {
    useTaskStore.setState({
      _allTasks: [
        makeTask('1', { title: 'Work done task', status: 'done', contexts: ['@work'] }),
        makeTask('2', { title: 'Home done task', status: 'done', contexts: ['@home'] }),
      ],
      lastDataChangeAt: 1,
    });

    const { getByRole, queryByText } = renderListView('done', 'Completed');

    expect(queryByText('Work done task')).toBeInTheDocument();
    expect(queryByText('Home done task')).toBeInTheDocument();

    fireEvent.click(getByRole('button', { name: 'Filters' }));
    const panel = document.getElementById('list-filters-panel');
    expect(panel).not.toBeNull();
    fireEvent.click(within(panel!).getByRole('button', { name: 'Contexts & tags' }));
    fireEvent.click(within(panel!).getByRole('button', { name: /@work/ }));

    await waitFor(() => {
      expect(queryByText('Work done task')).toBeInTheDocument();
      expect(queryByText('Home done task')).not.toBeInTheDocument();
    });
  });
});
