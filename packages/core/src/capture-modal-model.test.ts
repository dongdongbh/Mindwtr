import { describe, expect, it, vi } from 'vitest';
import { buildCaptureModalRequest, buildCaptureModalView, createCaptureModalDraft, formatCaptureModalCopilotApplied, planCaptureModalRequest, saveCaptureModalLines } from './capture-modal-model';
import { parseQuickAdd } from './quick-add';
import type { AppSettings, Project, Task } from './types';

const NOW = new Date('2026-09-28T14:00:00.000Z');
const request = (text: string, extra: { projects?: readonly Project[]; initialProps?: Partial<Task>; description?: string } = {}) => {
    const projects = extra.projects ?? [];
    return buildCaptureModalRequest({
        parsed: parseQuickAdd(text, projects as Project[], NOW, []),
        text,
        projects,
        initialProps: extra.initialProps ?? {},
        projectParam: '',
        defaultAreaId: undefined,
        description: extra.description ?? '',
        copilot: { tags: [] },
        timeEstimatesEnabled: true,
    });
};

describe('capture confirmation screen model', () => {
    // RN bug (apps/mobile/app/capture-modal.tsx:553, 586-593 before the move): the entry's
    // description stayed under the field, so an edited field saved both, and a cleared one
    // saved the entry's.
    it('saves the description field as it shows it, a typed /note: token after it', () => {
        const shared = { initialProps: { description: 'Body with https://example.com/doc\nhttps://example.com/doc' } };
        const description = (text: string, field: string) => {
            const plan = planCaptureModalRequest(request(text, { ...shared, description: field }));
            return plan.success ? plan.props.description : plan.reason;
        };
        expect(description('Subject', 'Body with https://example.com/doc')).toBe('Body with https://example.com/doc');
        expect(description('Subject', '   ')).toBeUndefined();
        expect(description('Subject /note:read later', 'Body')).toBe('Body\nread later');
        expect(description('Subject /note:read later', '')).toBe('read later');
    });

    // RN bug (apps/mobile/app/capture-modal.tsx:692-719 before the move): lines were prepared
    // one by one, so the project an earlier line named was created before a later line's
    // date command refused the batch.
    it('refuses a batch with an unreadable date command before any project or task is written', async () => {
        const addProject = vi.fn(async (title: string) => ({ id: `p-${title}`, title }) as Project);
        const addTasks = vi.fn(async () => ({ success: true }));
        const outcome = await saveCaptureModalLines({
            lines: ['Plan beds +Garden plan', 'Pay rent /due:whenever'],
            projects: [],
            buildRequest: async (line, projects) => request(line, { projects }),
            actions: { addProject, addTasks },
        });
        expect(outcome).toEqual({ kind: 'refused', invalidDateCommands: ['/due:whenever'] });
        expect(addProject).not.toHaveBeenCalled();
        expect(addTasks).not.toHaveBeenCalled();
    });

    // RN bug (apps/mobile/app/capture-modal.tsx:903-906 before the move): the estimate and the
    // tags ran together ("Applied @phone 15min#finance").
    it('spaces every applied copilot part', () => {
        const t = (key: string) => (key === 'copilot.applied' ? 'Applied' : key);
        expect(formatCaptureModalCopilotApplied(t, { context: '@phone', timeEstimate: '15min', tags: ['#finance', '#urgent'] }, true))
            .toBe('Applied @phone 15min #finance #urgent');
        expect(formatCaptureModalCopilotApplied(t, { timeEstimate: '15min', tags: ['#urgent'] }, true)).toBe('Applied 15min #urgent');
        expect(formatCaptureModalCopilotApplied(t, { context: '@computer', tags: [] }, true)).toBe('Applied @computer');
        expect(formatCaptureModalCopilotApplied(t, { timeEstimate: '15min', tags: ['#urgent'] }, false)).toBe('Applied #urgent');
        expect(formatCaptureModalCopilotApplied(t, { tags: [] }, true)).toBeNull();
    });

    // RN 318edcba8 (#828): the capture screen's AI copilot also offers the saved contexts and tags no task uses yet, after the
    // used ones (apps/mobile/app/capture-modal.tsx contextOptions, tagOptions).
    it('offers the AI the saved contexts and tags after the used ones', () => {
        const at = '2026-10-20T00:00:00.000Z';
        const saved = (token: string) => ({ token, rev: 1, revBy: 'device', updatedAt: at });
        const settings = {
            ai: { enabled: true, provider: 'openai', baseUrl: 'http://localhost:11434/v1' },
            taxonomy: { contexts: [saved('@errands'), saved('@phone')], tags: [saved('#someday'), { ...saved('#gone'), deletedAt: at }] },
        } as unknown as AppSettings;
        const tasks = [{ id: 't1', title: 'Call', status: 'next', contexts: ['@phone'], tags: ['#finance'], createdAt: at, updatedAt: at }] as Task[];
        const view = buildCaptureModalView(createCaptureModalDraft({ initialValue: 'Call the bank' }, {}), {
            t: (key: string) => key,
            settings,
            projects: [],
            areas: [],
            tasks,
            initialProps: {},
            parsed: parseQuickAdd('Call the bank', [], NOW, []),
            formatDate: () => '',
            aiKey: { required: false, available: false },
        });
        expect(view.copilot.request).toEqual({ title: 'Call the bank', contexts: ['@phone', '@errands'], tags: ['#finance', '#someday'] });
    });
});
