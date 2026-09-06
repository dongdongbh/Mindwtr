import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppData, Person, Project, Task } from '@mindwtr/core';

const fileSystemMocks = vi.hoisted(() => ({
    documentDirectory: 'file:///data/Documents/',
    getInfoAsync: vi.fn(),
    readDirectoryAsync: vi.fn(),
    readAsStringAsync: vi.fn(),
    deleteAsync: vi.fn(),
}));

vi.mock('./file-system', () => fileSystemMocks);
const appLogMocks = vi.hoisted(() => ({
    logError: vi.fn(async () => undefined),
    logInfo: vi.fn(async () => undefined),
    logWarn: vi.fn(async () => undefined),
}));
vi.mock('./app-log', () => appLogMocks);

import { buildPendingCaptureTaskProps, ingestPendingCaptures, parsePendingCapture } from './pending-captures';

const project = (props: Partial<Project>): Project => ({
    id: 'p1',
    title: 'Errands',
    status: 'active',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    ...props,
} as Project);

describe('parsePendingCapture', () => {
    it('parses a full payload and splits tags', () => {
        expect(parsePendingCapture(JSON.stringify({
            id: 'abc',
            title: 'Take out the trash',
            note: 'Bins to the curb',
            tags: 'home, chores',
            project: 'Errands',
        }))).toEqual({
            id: 'abc',
            title: 'Take out the trash',
            note: 'Bins to the curb',
            tags: ['home', 'chores'],
            project: 'Errands',
        });
    });

    it('rejects payloads without id or title', () => {
        expect(parsePendingCapture(JSON.stringify({ title: 'No id' }))).toBeNull();
        expect(parsePendingCapture(JSON.stringify({ id: 'x', title: '   ' }))).toBeNull();
        expect(parsePendingCapture('not json')).toBeNull();
        expect(parsePendingCapture('[]')).toBeNull();
    });

    it('accepts a valid ISO due/start date and collapses it to a date-only string', () => {
        const capture = parsePendingCapture(JSON.stringify({
            id: 'a',
            title: 'Renew passport',
            dueDate: '2026-08-14',
            startDate: '2026-08-01T09:30:00',
        }));
        expect(capture?.dueDate).toBe('2026-08-14');
        // The Shortcut's Date parameter always carries a time; it must collapse
        // to the local calendar day so it never arms a start reminder (#755).
        expect(capture?.startDate).toBe('2026-08-01');
    });

    it('ignores invalid due/start date junk without failing the capture', () => {
        const capture = parsePendingCapture(JSON.stringify({
            id: 'a',
            title: 'Renew passport',
            dueDate: 'not-a-date',
            startDate: '',
        }));
        expect(capture).not.toBeNull();
        expect(capture?.dueDate).toBeUndefined();
        expect(capture?.startDate).toBeUndefined();
    });
});

describe('buildPendingCaptureTaskProps', () => {
    it('lands in inbox with normalized tags', () => {
        const props = buildPendingCaptureTaskProps(
            { id: 'a', title: 'T', note: 'N', tags: ['home', '#home', 'chores'] },
            [],
        );
        expect(props.status).toBe('inbox');
        expect(props.description).toBe('N');
        expect(props.tags).toEqual(['#home', '#chores']);
    });

    it('resolves selectable projects by id or title and drops unknown or archived ones', () => {
        const active = project({ id: 'p1', title: 'Errands' });
        const archived = project({ id: 'p2', title: 'Old', status: 'archived' as Project['status'] });

        expect(buildPendingCaptureTaskProps({ id: 'a', title: 'T', tags: [], project: 'errands' }, [active]).projectId).toBe('p1');
        expect(buildPendingCaptureTaskProps({ id: 'a', title: 'T', tags: [], project: 'p1' }, [active]).projectId).toBe('p1');
        expect(buildPendingCaptureTaskProps({ id: 'a', title: 'T', tags: [], project: 'Old' }, [archived]).projectId).toBeUndefined();
        expect(buildPendingCaptureTaskProps({ id: 'a', title: 'T', tags: [], project: 'Nope' }, [active]).projectId).toBeUndefined();
    });

    it('maps structured dueDate/startDate onto the task, startDate to startTime', () => {
        const props = buildPendingCaptureTaskProps(
            { id: 'a', title: 'T', tags: [], dueDate: '2026-08-14', startDate: '2026-08-01' },
            [],
        );
        expect(props.dueDate).toBe('2026-08-14');
        expect(props.startTime).toBe('2026-08-01');
    });
});

describe('ingestPendingCaptures', () => {
    let addProject: ReturnType<typeof vi.fn>;
    const emptySettings = {} as AppData['settings'];

    const oneFile = (name: string, body: Record<string, unknown>) => {
        fileSystemMocks.readDirectoryAsync.mockResolvedValue([name]);
        fileSystemMocks.readAsStringAsync.mockResolvedValue(JSON.stringify(body));
    };

    // Typed so `addTask.mock.calls[0]` destructures as [title, props] instead
    // of an empty tuple (vi.fn() with a zero-arg implementation infers no
    // parameters).
    const addTaskMock = () => vi.fn(async (_title: string, _props?: Partial<Task>) => ({ id: 'task-1' }));

    beforeEach(() => {
        vi.clearAllMocks();
        fileSystemMocks.getInfoAsync.mockResolvedValue({ exists: true });
        fileSystemMocks.deleteAsync.mockResolvedValue(undefined);
        addProject = vi.fn(async (title: string) => project({ id: 'created-project', title }));
    });

    it('creates a task per queue file and deletes each file after the write resolves', async () => {
        fileSystemMocks.readDirectoryAsync.mockResolvedValue(['b.json', 'a.json', 'ignore.txt']);
        fileSystemMocks.readAsStringAsync.mockImplementation(async (uri: string) => JSON.stringify({
            id: uri.includes('a.json') ? 'a' : 'b',
            title: uri.includes('a.json') ? 'First' : 'Second',
            tags: 'home',
        }));
        const addTask = vi.fn(async () => ({ id: 'task-1' }));

        const ingested = await ingestPendingCaptures({ addTask, addProject, projects: [], areas: [], tasks: [], people: [], settings: emptySettings });

        expect(ingested).toBe(2);
        expect(addTask).toHaveBeenNthCalledWith(1, 'First', { status: 'inbox', tags: ['#home'] });
        expect(addTask).toHaveBeenNthCalledWith(2, 'Second', { status: 'inbox', tags: ['#home'] });
        expect(fileSystemMocks.deleteAsync).toHaveBeenCalledTimes(2);
    });

    it('logs the release check once per ingested Android quick-capture item, and never for a Shortcut item', async () => {
        fileSystemMocks.readDirectoryAsync.mockResolvedValue(['a.json', 'b.json']);
        fileSystemMocks.readAsStringAsync.mockImplementation(async (uri: string) => JSON.stringify(
            uri.includes('a.json')
                ? { id: 'a', title: 'From the dialog', createdAt: '2026-09-06T10:00:00.000Z', source: 'android-quick-capture' }
                : { id: 'b', title: 'From the Shortcut' },
        ));
        const addTask = addTaskMock();

        expect(await ingestPendingCaptures({ addTask, addProject, projects: [], areas: [], tasks: [], people: [], settings: emptySettings })).toBe(2);

        expect(addTask).toHaveBeenNthCalledWith(1, 'From the dialog', { status: 'inbox' });
        expect(appLogMocks.logInfo).toHaveBeenCalledTimes(1);
        expect(appLogMocks.logInfo).toHaveBeenCalledWith('Quick capture dialog item ingested', {
            scope: 'capture',
            extra: { releaseCheck: 'v1.2.9/android-quick-capture-dialog' },
        });
    });

    it('keeps the file when the store write reports failure', async () => {
        fileSystemMocks.readDirectoryAsync.mockResolvedValue(['a.json']);
        fileSystemMocks.readAsStringAsync.mockResolvedValue(JSON.stringify({ id: 'a', title: 'Keep me' }));
        const addTask = vi.fn(async () => ({ success: false }));

        const ingested = await ingestPendingCaptures({ addTask, addProject, projects: [], areas: [], tasks: [], people: [], settings: emptySettings });

        expect(ingested).toBe(0);
        expect(fileSystemMocks.deleteAsync).not.toHaveBeenCalled();
    });

    it('discards malformed files without creating tasks', async () => {
        fileSystemMocks.readDirectoryAsync.mockResolvedValue(['bad.json']);
        fileSystemMocks.readAsStringAsync.mockResolvedValue('{broken');
        const addTask = vi.fn();

        const ingested = await ingestPendingCaptures({ addTask, addProject, projects: [], areas: [], tasks: [], people: [], settings: emptySettings });

        expect(ingested).toBe(0);
        expect(addTask).not.toHaveBeenCalled();
        expect(fileSystemMocks.deleteAsync).toHaveBeenCalledTimes(1);
    });

    it('does nothing when the queue directory does not exist', async () => {
        fileSystemMocks.getInfoAsync.mockResolvedValue({ exists: false });
        const addTask = vi.fn();

        expect(await ingestPendingCaptures({ addTask, addProject, projects: [], areas: [], tasks: [], people: [], settings: emptySettings })).toBe(0);
        expect(fileSystemMocks.readDirectoryAsync).not.toHaveBeenCalled();
        expect(addTask).not.toHaveBeenCalled();
    });

    it('parses quick-add syntax and strips it from the title when cleanup is ON', async () => {
        oneFile('a.json', { id: 'a', title: 'Buy milk /due:2026-07-24 @errands #personal' });
        const addTask = addTaskMock();
        const settings = { quickAddAutoClean: true } as AppData['settings'];

        const ingested = await ingestPendingCaptures({ addTask, addProject, projects: [], areas: [], tasks: [], people: [], settings });

        expect(ingested).toBe(1);
        expect(addTask).toHaveBeenCalledTimes(1);
        const [title, props] = addTask.mock.calls[0] as [string, Partial<Task>];
        expect(title).toBe('Buy milk');
        expect(props.dueDate).toBe('2026-07-24');
        expect(props.contexts).toContain('@errands');
        expect(props.tags).toContain('#personal');
    });

    it('still consumes applied syntax with cleanup OFF (default)', async () => {
        oneFile('a.json', { id: 'a', title: 'Buy milk /due:2026-07-24 @errands #personal' });
        const addTask = addTaskMock();

        const ingested = await ingestPendingCaptures({ addTask, addProject, projects: [], areas: [], tasks: [], people: [], settings: emptySettings });

        expect(ingested).toBe(1);
        const [title, props] = addTask.mock.calls[0] as [string, Partial<Task>];
        // Cleanup off keeps ordinary text as typed; it never keeps a token the
        // parser already turned into a field.
        expect(title).toBe('Buy milk');
        expect(props.dueDate).toBe('2026-07-24');
        expect(props.contexts).toContain('@errands');
        expect(props.tags).toContain('#personal');
    });

    it('matches a multi-word person against the people list, like the in-app capture box', async () => {
        oneFile('a.json', { id: 'a', title: 'Chase invoice %Jim Smith' });
        const addTask = addTaskMock();
        const people = [{ id: 'person-1', name: 'Jim Smith' } as Person];

        await ingestPendingCaptures({ addTask, addProject, projects: [], areas: [], tasks: [], people, settings: emptySettings });

        const [title, props] = addTask.mock.calls[0] as [string, Partial<Task>];
        // Without the people list the parser takes only the first word, so this
        // capture used to create a second person called "Jim" (see #895).
        expect(props.assignedTo).toBe('Jim Smith');
        expect(title).toBe('Chase invoice');
    });

    it('attaches an existing selectable project matched by a parsed +Project token without creating one', async () => {
        const active = project({ id: 'p-active', title: 'Errands' });
        oneFile('a.json', { id: 'a', title: 'Buy milk +Errands' });
        const addTask = addTaskMock();

        await ingestPendingCaptures({ addTask, addProject, projects: [active], areas: [], tasks: [], people: [], settings: emptySettings });

        expect(addProject).not.toHaveBeenCalled();
        const [, props] = addTask.mock.calls[0] as [string, Partial<Task>];
        expect(props.projectId).toBe('p-active');
    });

    it('creates a project for a parsed +Project token naming an unknown project', async () => {
        oneFile('a.json', { id: 'a', title: 'Buy milk +NewProject' });
        const addTask = addTaskMock();

        await ingestPendingCaptures({ addTask, addProject, projects: [], areas: [], tasks: [], people: [], settings: emptySettings });

        expect(addProject).toHaveBeenCalledTimes(1);
        expect(addProject.mock.calls[0][0]).toBe('NewProject');
        const [, props] = addTask.mock.calls[0] as [string, Partial<Task>];
        expect(props.projectId).toBe('created-project');
    });

    it('lets the structured project field beat a parsed +Project token, without creating a project', async () => {
        const active = project({ id: 'p-active', title: 'Errands' });
        oneFile('a.json', { id: 'a', title: 'Buy milk +UnknownProject', project: 'Errands' });
        const addTask = addTaskMock();

        await ingestPendingCaptures({ addTask, addProject, projects: [active], areas: [], tasks: [], people: [], settings: emptySettings });

        expect(addProject).not.toHaveBeenCalled();
        const [, props] = addTask.mock.calls[0] as [string, Partial<Task>];
        expect(props.projectId).toBe('p-active');
    });

    it('lets the structured due/start date beat a parsed /due: token', async () => {
        oneFile('a.json', { id: 'a', title: 'Buy milk /due:2026-07-24', dueDate: '2026-08-14', startDate: '2026-08-01' });
        const addTask = addTaskMock();

        await ingestPendingCaptures({ addTask, addProject, projects: [], areas: [], tasks: [], people: [], settings: emptySettings });

        const [, props] = addTask.mock.calls[0] as [string, Partial<Task>];
        expect(props.dueDate).toBe('2026-08-14');
        expect(props.startTime).toBe('2026-08-01');
    });

    it('unions structured tags with parsed #tags, deduped', async () => {
        oneFile('a.json', { id: 'a', title: 'Buy milk #urgent', tags: 'work,urgent' });
        const addTask = addTaskMock();

        await ingestPendingCaptures({ addTask, addProject, projects: [], areas: [], tasks: [], people: [], settings: emptySettings });

        const [, props] = addTask.mock.calls[0] as [string, Partial<Task>];
        expect(props.tags).toEqual(expect.arrayContaining(['#urgent', '#work']));
        expect(new Set(props.tags).size).toBe(props.tags?.length);
    });

    it('resolves relative dates against the capture time, not the drain time', async () => {
        // Queued on Monday 2026-07-13; "friday" must mean that week's Friday
        // no matter when the app next foregrounds and drains the queue.
        oneFile('a.json', { id: 'a', title: 'Buy milk /due:friday', createdAt: '2026-07-13T12:00:00' });
        const addTask = addTaskMock();

        await ingestPendingCaptures({ addTask, addProject, projects: [], areas: [], tasks: [], people: [], settings: emptySettings });

        const [, props] = addTask.mock.calls[0] as [string, Partial<Task>];
        expect(props.dueDate).toBe('2026-07-17');
    });

    it('falls back to the verbatim title when the quick-add date command is invalid, and still creates the task', async () => {
        oneFile('a.json', { id: 'a', title: 'Buy milk /due:2026-04-31' });
        const addTask = addTaskMock();

        const ingested = await ingestPendingCaptures({ addTask, addProject, projects: [], areas: [], tasks: [], people: [], settings: emptySettings });

        expect(ingested).toBe(1);
        expect(addTask).toHaveBeenCalledWith('Buy milk /due:2026-04-31', { status: 'inbox' });
        expect(fileSystemMocks.deleteAsync).toHaveBeenCalledTimes(1);
    });

    it('falls back to the verbatim capture when project creation fails, and keeps draining the queue', async () => {
        fileSystemMocks.readDirectoryAsync.mockResolvedValue(['a.json', 'b.json']);
        fileSystemMocks.readAsStringAsync.mockImplementation(async (uri: string) => JSON.stringify(
            uri.includes('a.json')
                ? { id: 'a', title: 'Buy milk +NewProject' }
                : { id: 'b', title: 'Water plants' },
        ));
        addProject.mockRejectedValue(new Error('store unavailable'));
        const addTask = addTaskMock();

        const ingested = await ingestPendingCaptures({ addTask, addProject, projects: [], areas: [], tasks: [], people: [], settings: emptySettings });

        expect(ingested).toBe(2);
        expect(addTask).toHaveBeenNthCalledWith(1, 'Buy milk +NewProject', { status: 'inbox' });
        expect(addTask).toHaveBeenNthCalledWith(2, 'Water plants', { status: 'inbox' });
        expect(fileSystemMocks.deleteAsync).toHaveBeenCalledTimes(2);
    });

    it('falls back to the verbatim capture when assembly throws, and keeps draining the queue', async () => {
        fileSystemMocks.readDirectoryAsync.mockResolvedValue(['a.json', 'b.json']);
        fileSystemMocks.readAsStringAsync.mockImplementation(async (uri: string) => JSON.stringify(
            uri.includes('a.json')
                ? { id: 'a', title: 'First' }
                : { id: 'b', title: 'Second' },
        ));
        // Assembly reads settings.gtd while building parse options; a throw
        // there stands in for any unexpected error inside assembly, which must
        // degrade to the verbatim capture instead of aborting the drain.
        const poisonedSettings = Object.defineProperty({}, 'gtd', {
            get() { throw new Error('boom'); },
        }) as AppData['settings'];
        const addTask = addTaskMock();

        const ingested = await ingestPendingCaptures({ addTask, addProject, projects: [], areas: [], tasks: [], people: [], settings: poisonedSettings });

        expect(ingested).toBe(2);
        expect(addTask).toHaveBeenNthCalledWith(1, 'First', { status: 'inbox' });
        expect(addTask).toHaveBeenNthCalledWith(2, 'Second', { status: 'inbox' });
        expect(fileSystemMocks.deleteAsync).toHaveBeenCalledTimes(2);
    });
});
