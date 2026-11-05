import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useTaskStore } from '@mindwtr/core';

import { LanguageProvider } from '../contexts/language-context';
import { QuickAddModal } from './QuickAddModal';

const coreSpies = vi.hoisted(() => ({
    parseQuickAdd: vi.fn(),
}));


vi.mock('@mindwtr/core', async () => {
    const actual = await vi.importActual<typeof import('@mindwtr/core')>('@mindwtr/core');
    coreSpies.parseQuickAdd.mockImplementation(actual.parseQuickAdd);
    return { ...actual, parseQuickAdd: coreSpies.parseQuickAdd };
});

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => false) }));
vi.mock('@tauri-apps/api/event', () => ({ emitTo: vi.fn(async () => undefined), listen: vi.fn(async () => () => undefined) }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ hide: vi.fn(async () => undefined) }) }));
vi.mock('@tauri-apps/plugin-fs', () => ({
    BaseDirectory: { Data: 'Data' },
    mkdir: vi.fn(async () => undefined),
    readFile: vi.fn(async () => new Uint8Array()),
    remove: vi.fn(async () => undefined),
    writeFile: vi.fn(async () => undefined),
}));
vi.mock('@tauri-apps/api/path', () => ({
    dataDir: vi.fn(async () => '/data'),
    join: vi.fn(async (...parts: string[]) => parts.join('/')),
}));

const DRAFT = 'call mom @errands #family /due:tomorrow';

const initialTaskState = useTaskStore.getState();
const addTask = vi.fn(async () => ({ success: true, id: 'task-id' }));

const openModalWithDraft = async () => {
    render(
        <LanguageProvider>
            <QuickAddModal />
        </LanguageProvider>
    );
    await act(async () => {
        window.dispatchEvent(new CustomEvent('mindwtr:quick-add', { detail: {} }));
        await Promise.resolve();
    });
    const input = screen.getByPlaceholderText('Add Task');
    await act(async () => {
        fireEvent.change(input, { target: { value: DRAFT } });
        await Promise.resolve();
    });
};

beforeEach(() => {
    coreSpies.parseQuickAdd.mockClear();
    addTask.mockClear();
    act(() => {
        useTaskStore.setState(initialTaskState, true);
        useTaskStore.setState((state) => ({
            ...state,
            _allProjects: [],
            _allAreas: [],
            addTask,
            tasks: [
                { id: 'seed', title: 'seed', status: 'inbox', contexts: ['@errands'], tags: ['#family'] },
            ] as never,
        }));
    });
});

describe('QuickAddModal live preview', () => {
    it.each(
        ['"John Smith"', '“John Smith”', '”John Smith”', '„John Smith"'].flatMap((quotedName) => (
            [false, true].flatMap((knownPerson) => [false, true].map((trailingSpace) => ({
                quotedName, knownPerson, trailingSpace,
            })))
        )),
    )(
        'keeps the previewed person on section capture: $quotedName, known=$knownPerson, trailingSpace=$trailingSpace (#849)',
        async ({ quotedName, knownPerson, trailingSpace }) => {
            const user = userEvent.setup();
            if (knownPerson) {
                useTaskStore.setState({ _allPeople: [{
                    id: 'person-849', name: 'John Smith',
                    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
                }] });
            }
            render(<LanguageProvider><QuickAddModal /></LanguageProvider>);
            await act(async () => {
                window.dispatchEvent(new CustomEvent('mindwtr:quick-add', {
                    detail: { initialProps: { projectId: 'project-849', sectionId: 'section-849', status: 'next' } },
                }));
            });
            await user.type(screen.getByRole('combobox'), `Taskname %${quotedName} /waiting${trailingSpace ? ' ' : ''}`);
            const previewCall = coreSpies.parseQuickAdd.mock.calls[coreSpies.parseQuickAdd.mock.calls.length - 1];
            expect(previewCall[4].knownPeople).toEqual(knownPerson ? ['John Smith'] : []);
            expect(screen.getByTestId('quick-add-preview')).toHaveTextContent('John Smith');

            if (!trailingSpace) {
                await user.keyboard('{Enter}');
                expect(addTask).not.toHaveBeenCalled();
                expect(screen.getByTestId('quick-add-preview')).toHaveTextContent('John Smith');
            }
            await user.keyboard('{Enter}');
            await waitFor(() => expect(addTask).toHaveBeenCalledWith('Taskname', expect.objectContaining({
                assignedTo: 'John Smith',
                status: 'waiting',
                projectId: 'project-849',
                sectionId: 'section-849',
            })));
            expect(addTask).toHaveBeenCalledTimes(1);
        },
    );

    it('previews and saves the exact typed custom estimate (#1358)', async () => {
        await openModalWithDraft();
        fireEvent.change(screen.getByPlaceholderText('Add Task'), { target: { value: 'Write report /estimate:1h30m' } });
        expect(screen.getByTestId('quick-add-preview')).toHaveTextContent('Time Estimate');
        expect(screen.getByTestId('quick-add-preview')).toHaveTextContent('1h 30m');
        fireEvent.click(screen.getByRole('button', { name: 'Save' }));
        await waitFor(() => expect(addTask).toHaveBeenCalledWith('Write report', expect.objectContaining({ timeEstimate: 'custom:90' })));
    });

    it('shows what the parser found in the draft', async () => {
        await openModalWithDraft();

        const preview = screen.getByTestId('quick-add-preview');
        expect(preview).toHaveTextContent('@errands');
        expect(preview).toHaveTextContent('#family');

        expect(preview).toHaveTextContent('Due Date');
        expect(preview).not.toHaveTextContent('/due:tomorrow');
    });

    it('parses the preview with the same input and options the save uses', async () => {
        await openModalWithDraft();

        const previewCalls = coreSpies.parseQuickAdd.mock.calls.length;
        expect(previewCalls).toBeGreaterThan(0);
        const previewCall = coreSpies.parseQuickAdd.mock.calls[previewCalls - 1];

        fireEvent.click(screen.getByRole('button', { name: 'Save' }));
        await waitFor(() => expect(addTask).toHaveBeenCalled());

        const submitCall = coreSpies.parseQuickAdd.mock.calls[previewCalls];
        expect(submitCall).toBeDefined();


        expect(submitCall[0]).toBe(previewCall[0]);
        expect(submitCall[1]).toBe(previewCall[1]);
        expect(submitCall[3]).toBe(previewCall[3]);
        expect(submitCall[4]).toBe(previewCall[4]);
    });

    it('warns about an invalid date command instead of failing silently on save', async () => {
        render(
            <LanguageProvider>
                <QuickAddModal />
            </LanguageProvider>
        );
        await act(async () => {
            window.dispatchEvent(new CustomEvent('mindwtr:quick-add', { detail: {} }));
            await Promise.resolve();
        });
        await act(async () => {
            fireEvent.change(screen.getByPlaceholderText('Add Task'), { target: { value: 'call mom /due:notaday' } });
            await Promise.resolve();
        });

        expect(screen.getByTestId('quick-add-preview')).toHaveTextContent('/due:notaday');
    });
});
