import type { NativeHostResult } from './native-host-contract';
import { exact, record } from './native-host-contract-project-shared';
import { SOMEDAY_SECTION_UUID, hasUnpairedSurrogate } from './native-host-contract-someday-section-shared';
import { createNativeRequestReceipts, refuseStaleProjects, runStoreWrite, settleWrite } from './native-request-receipts';
import { logInfo } from './logger';
import { useTaskStore } from './store';
import type { Project, ViewSectionDefinition } from './types';
import { buildProjectViewSectionUpdate, sortViewSectionDefinitions } from './view-sections';

export type NativeSomedayProjectSectionMoveRequest = {
    requestId: string;
    projectId: string;
    projectRevision: string;
    fromSectionId: string | null;
    sectionId: string | null;
};
export type NativeSomedayProjectSectionMoveResult = { id: string; changed: boolean };

const fail = (code: 'INVALID_INPUT' | 'STALE_REVISION' | 'SAVE_FAILED', message: string): NativeHostResult<never> =>
    ({ ok: false, error: { code, message } });
const validId = (value: unknown, limit: number): value is string =>
    typeof value === 'string' && Boolean(value.trim()) && value.length <= limit
    && !value.includes('\0') && !hasUnpairedSurrogate(value);
const validSection = (value: unknown): value is string | null => value === null || validId(value, 500);

const readRequest = (input: unknown): NativeSomedayProjectSectionMoveRequest | null => {
    if (!record(input) || !exact(input, ['requestId', 'projectId', 'projectRevision', 'fromSectionId', 'sectionId'])
        || typeof input.requestId !== 'string' || !SOMEDAY_SECTION_UUID.test(input.requestId)
        || !validId(input.projectId, 500) || !validId(input.projectRevision, 200)
        || !validSection(input.fromSectionId) || !validSection(input.sectionId)) return null;
    return { requestId: input.requestId, projectId: input.projectId, projectRevision: input.projectRevision,
        fromSectionId: input.fromSectionId, sectionId: input.sectionId };
};
const answer = (request: NativeSomedayProjectSectionMoveRequest): NativeSomedayProjectSectionMoveResult =>
    ({ id: request.projectId, changed: request.fromSectionId !== request.sectionId });
const parked = (id: string): Project | null => {
    const project = useTaskStore.getState()._projectsById.get(id);
    return project && !project.deletedAt && project.status === 'someday' ? project : null;
};
const liveSections = (): ViewSectionDefinition[] =>
    sortViewSectionDefinitions(useTaskStore.getState().settings.gtd?.viewSections?.someday as ViewSectionDefinition[] | undefined);
const placedIn = (project: Project): string | null => {
    const id = project.viewSectionIds?.someday;
    return id && liveSections().some((entry) => entry.id === id) ? id : null;
};

export function validateSomedayProjectSectionMoveWrite(input: unknown): NativeHostResult<NativeSomedayProjectSectionMoveResult> {
    const request = readRequest(input);
    return request ? { ok: true, value: answer(request) }
        : fail('INVALID_INPUT', 'A parked Someday project, the section it showed, a target section and a request UUID are required');
}

export function createSomedayProjectSectionMoveMethods(deps: {
    readiness: () => NativeHostResult<null>;
    save: () => Promise<NativeHostResult<null>>;
}) {
    const durableSave = async (): Promise<NativeHostResult<null>> => {
        try {
            if (useTaskStore.getState().persistenceFailure) await useTaskStore.getState().retryPersistence();
        } catch (error) {
            return fail('SAVE_FAILED', error instanceof Error ? error.message : String(error));
        }
        return deps.save();
    };
    const receipts = createNativeRequestReceipts({ save: durableSave });
    const target = (request: NativeSomedayProjectSectionMoveRequest): NativeHostResult<NativeSomedayProjectSectionMoveResult> => {
        const project = parked(request.projectId);
        return project && placedIn(project) === request.sectionId ? { ok: true, value: answer(request) }
            : fail('STALE_REVISION', 'Someday project section move outcome is not present');
    };

    return {
        validateSomedayProjectSectionMoveWrite,

        probeSomedayProjectSectionMoveOutcome(input: NativeSomedayProjectSectionMoveRequest): NativeHostResult<NativeSomedayProjectSectionMoveResult> {
            const request = readRequest(input);
            if (!request) return validateSomedayProjectSectionMoveWrite(input);
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const identity = receipts.checkIdentity(request.requestId, JSON.stringify(request));
            return identity.ok ? target(request) : identity;
        },

        async moveSomedayProjectToSectionChecked(input: NativeSomedayProjectSectionMoveRequest): Promise<NativeHostResult<NativeSomedayProjectSectionMoveResult>> {
            const request = readRequest(input);
            if (!request) return validateSomedayProjectSectionMoveWrite(input);
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const payload = JSON.stringify(request);
            const identity = receipts.checkIdentity(request.requestId, payload);
            if (!identity.ok) return identity;
            if (!answer(request).changed) return target(request);
            const outcome = await receipts.run(request.requestId, payload, async () => {
                const applied = target(request);
                if (applied.ok) return applied;
                const project = parked(request.projectId);
                if (!project) return fail('STALE_REVISION', 'Only a parked Someday project can move to a section');
                if (placedIn(project) !== request.fromSectionId) return fail('STALE_REVISION', 'The project moved since it was shown');
                const stale = refuseStaleProjects([project.id], { [project.id]: request.projectRevision });
                if (stale) return stale;
                if (request.sectionId !== null && !liveSections().some((entry) => entry.id === request.sectionId)) {
                    return fail('STALE_REVISION', 'That Someday section is gone');
                }
                const update = buildProjectViewSectionUpdate(project, 'someday', request.sectionId ?? undefined);
                if (!update) return applied;
                const written = await runStoreWrite(() => useTaskStore.getState().updateProject(project.id, update));
                return settleWrite(written, answer(request));
            });
            if (!outcome.ok) return outcome;
            const confirmed = target(request);
            if (confirmed.ok) {
                try { logInfo('Native Someday project section move confirmed', { scope: 'native-host', category: 'storage', force: true,
                    context: { releaseCheck: 'v1.3.9/ios-someday-project-section-move', outcome: request.sectionId === null ? 'no-section' : 'section' } }); }
                catch { }
            }
            return confirmed;
        },
    };
}
