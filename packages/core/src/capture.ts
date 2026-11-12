import type { Area, Project, Task } from './types';
import type { QuickAddResult } from './quick-add';
import type { StoreActionResult } from './store-types';
import { getQuickAddProjectInitialProps } from './quick-add';
import { isSelectableProjectForTaskAssignment } from './project-utils';
import { DEFAULT_AREA_COLOR, DEFAULT_PROJECT_COLOR } from './color-constants';
import { resolveCaptureStatusForStart } from './store-helpers';
import { logInfo } from './logger';


export type CaptureAssemblyInput = {
    parsed: Pick<QuickAddResult, 'title' | 'props' | 'projectTitle' | 'detectedDate' | 'invalidDateCommands'>;
    rawInput: string;

    fallbackTitle?: string;
    projects: readonly Project[];

    initialProps?: Partial<Task>;

    extraProps?: Partial<Task>;

    selectedAreaId?: string | null;

    starNewTask?: boolean;

    suppressDetectedDate?: boolean;
};

export type CaptureProjectToCreate = {
    title: string;
    color: string;
    initialProps?: Partial<Project>;
};

export type CaptureAssembly =
    | { ok: false; reason: 'empty-title' }
    | {
        ok: true;
        title: string;
        props: Partial<Task>;

        projectToCreate?: CaptureProjectToCreate;
        invalidDateCommands?: string[];
    };

export type CaptureTransactionActions = {
    addProject: (
        title: string,
        color: string,
        initialProps?: Partial<Project>,
    ) => Promise<Project | null>;
    addTask: (title: string, initialProps?: Partial<Task>) => Promise<StoreActionResult>;
};

export type CaptureTransactionOptions = {


    transformProps?: (props: Partial<Task>) => Partial<Task>;
};

export type CapturePreparationFailure =
    | { success: false; reason: 'empty-title' }
    | { success: false; reason: 'invalid-date-command'; invalidDateCommands: string[] }
    | { success: false; reason: 'project-create-failed'; error: string };

export type PreparedCaptureTask = {
    success: true;
    title: string;
    props: Partial<Task>;
    invalidDateCommands?: string[];
    createdProject?: Project;
};

export type CaptureTransactionResult =
    | CapturePreparationFailure
    | {
        success: false;
        reason: 'task-create-failed';
        error: string;
        title: string;
        props: Partial<Task>;
        createdProject?: Project;
    }
    | (PreparedCaptureTask & {
        taskResult: StoreActionResult;
        createdTaskId?: string;
    });

const findSelectableProjectByTitle = (
    projects: readonly Project[],
    title: string,
): Project | undefined => {
    const normalized = title.toLowerCase();
    return projects.find((project) => (
        project.title.toLowerCase() === normalized
        && isSelectableProjectForTaskAssignment(project)
    ));
};

const isAssignableProjectId = (projects: readonly Project[], projectId: string | undefined): boolean =>
    Boolean(projectId && projects.some((project) => (
        project.id === projectId && isSelectableProjectForTaskAssignment(project)
    )));

const normalizeCaptureQuery = (value: string): string => value.trim().toLowerCase();

export type CaptureProjectQueryResolution =
    | { kind: 'empty' }
    | { kind: 'select'; project: Project }
    | { kind: 'create'; projectToCreate: CaptureProjectToCreate };

export type CaptureAreaToCreate = {
    name: string;
    color: string;
};

export type CaptureAreaQueryResolution =
    | { kind: 'empty' }
    | { kind: 'select'; area: Area }
    | { kind: 'create'; areaToCreate: CaptureAreaToCreate };

export function filterCaptureProjects(
    projects: readonly Project[],
    options: { selectedAreaId?: string | null; query?: string } = {},
): Project[] {
    const query = normalizeCaptureQuery(options.query ?? '');
    return projects
        .filter(isSelectableProjectForTaskAssignment)
        .filter((project) => !options.selectedAreaId || project.areaId === options.selectedAreaId)
        .filter((project) => !query || project.title.toLowerCase().includes(query));
}

export function filterCaptureAreas(areas: readonly Area[], queryValue = ''): Area[] {
    const query = normalizeCaptureQuery(queryValue);
    return areas
        .filter((area) => !area.deletedAt)
        .filter((area) => !query || area.name.toLowerCase().includes(query));
}

const findSelectableCaptureProjectByTitle = (
    projects: readonly Project[],
    title: string,
): Project | undefined => {
    const query = normalizeCaptureQuery(title);
    if (!query) return undefined;
    return projects.find((project) => (
        project.title.toLowerCase() === query
        && isSelectableProjectForTaskAssignment(project)
    ));
};

const findLiveCaptureAreaByName = (areas: readonly Area[], name: string): Area | undefined => {
    const query = normalizeCaptureQuery(name);
    if (!query) return undefined;
    return areas.find((area) => !area.deletedAt && area.name.trim().toLowerCase() === query);
};

export function hasExactCaptureProjectMatch(projects: readonly Project[], query: string): boolean {
    return Boolean(findSelectableCaptureProjectByTitle(projects, query));
}

export function hasExactCaptureAreaMatch(areas: readonly Area[], query: string): boolean {
    return Boolean(findLiveCaptureAreaByName(areas, query));
}

export function resolveCaptureProjectQuery(
    projects: readonly Project[],
    query: string,
    selectedAreaId?: string | null,
): CaptureProjectQueryResolution {
    const title = query.trim();
    if (!title) return { kind: 'empty' };
    const project = findSelectableCaptureProjectByTitle(projects, title);
    if (project) return { kind: 'select', project };
    return {
        kind: 'create',
        projectToCreate: {
            title,
            color: DEFAULT_PROJECT_COLOR,
            initialProps: getQuickAddProjectInitialProps({}, selectedAreaId ?? undefined),
        },
    };
}

export function resolveCaptureAreaQuery(areas: readonly Area[], query: string): CaptureAreaQueryResolution {
    const name = query.trim();
    if (!name) return { kind: 'empty' };
    const area = findLiveCaptureAreaByName(areas, name);
    if (area) return { kind: 'select', area };
    return {
        kind: 'create',
        areaToCreate: {
            name,
            color: DEFAULT_AREA_COLOR,
        },
    };
}

export function buildCaptureTaskProps(input: CaptureAssemblyInput): CaptureAssembly {
    const { parsed, projects } = input;


    const parsedProps = { ...parsed.props };
    if (parsedProps.projectId && !isAssignableProjectId(projects, parsedProps.projectId)) {
        delete parsedProps.projectId;
    }
    const props: Partial<Task> = {
        status: 'inbox',
        ...input.initialProps,
        ...parsedProps,
        ...input.extraProps,
    };
    if (!props.status) props.status = 'inbox';


    const detectedDate = parsed.detectedDate;
    const applyDetectedDate = Boolean(
        detectedDate?.date && !props.dueDate && !input.suppressDetectedDate,
    );
    if (applyDetectedDate && detectedDate) {
        props.dueDate = detectedDate.date;
    }

    const title = (applyDetectedDate && detectedDate
        ? detectedDate.titleWithoutDate
        : (parsed.title || input.rawInput.trim() || input.fallbackTitle || '')
    ).trim();
    if (!title) return { ok: false, reason: 'empty-title' };

    if (input.starNewTask) {


        props.isFocusedToday = true;
    }

    let projectToCreate: CaptureProjectToCreate | undefined;
    if (!props.projectId && parsed.projectTitle) {
        const existing = findSelectableProjectByTitle(projects, parsed.projectTitle);
        if (existing) {
            props.projectId = existing.id;
        } else {
            projectToCreate = {
                title: parsed.projectTitle,
                color: DEFAULT_PROJECT_COLOR,
                initialProps: getQuickAddProjectInitialProps(props, input.selectedAreaId ?? undefined),
            };
        }
    }


    const hasProjectHome = Boolean(props.projectId || projectToCreate);
    if (hasProjectHome) {
        props.areaId = undefined;
    } else if (!parsedProps.areaId && !props.areaId) {
        props.areaId = input.selectedAreaId || undefined;
    }

    return {
        ok: true,
        title,
        props,
        projectToCreate,
        invalidDateCommands: parsed.invalidDateCommands,
    };
}


export function applyCapturedProject(props: Partial<Task>, projectId: string): Partial<Task> {
    return { ...props, projectId, areaId: undefined };
}

const captureErrorMessage = (error: unknown, fallback: string): string => {
    if (error instanceof Error && error.message.trim()) return error.message;
    if (typeof error === 'string' && error.trim()) return error;
    return fallback;
};


export type CaptureTaskPlan = {
    success: true;
    title: string;
    props: Partial<Task>;

    projectToCreate?: CaptureProjectToCreate;
    invalidDateCommands?: string[];
};


export function planCaptureTask(
    input: CaptureAssemblyInput,
    options: CaptureTransactionOptions = {},
): Exclude<CapturePreparationFailure, { reason: 'project-create-failed' }> | CaptureTaskPlan {
    const invalidDateCommands = input.parsed.invalidDateCommands;
    if (invalidDateCommands?.length) {
        return {
            success: false,
            reason: 'invalid-date-command',
            invalidDateCommands: [...invalidDateCommands],
        };
    }

    const assembly = buildCaptureTaskProps(input);
    if (!assembly.ok) return { success: false, reason: assembly.reason };

    let props = options.transformProps
        ? options.transformProps({ ...assembly.props })
        : assembly.props;


    const statusChosen = Boolean(input.parsed.props.status || input.extraProps?.status);
    if (!statusChosen && props.status === 'inbox') {
        const { status: _defaultStatus, ...unchosen } = props;
        props = { ...props, status: resolveCaptureStatusForStart(unchosen, 'inbox') };
    }


    if (props.projectId) {
        props = applyCapturedProject(props, props.projectId);
    }

    if (input.parsed.props.dueReminderLeadMinutes !== undefined || input.parsed.props.startReminderLeadMinutes !== undefined) {
        logInfo('Capture reminder options prepared', {
            scope: 'capture', category: 'validation', force: true,
            context: { releaseCheck: 'v1.3.9/capture-reminder-syntax', outcome: 'prepared',
                dueLeadMinutes: props.dueReminderLeadMinutes ?? 0, startLeadMinutes: props.startReminderLeadMinutes ?? 0 },
        });
    }

    return {
        success: true,
        title: assembly.title,
        props,
        invalidDateCommands: assembly.invalidDateCommands,
        ...(!props.projectId && assembly.projectToCreate ? { projectToCreate: assembly.projectToCreate } : {}),
    };
}


export async function prepareCaptureTask(
    input: CaptureAssemblyInput,
    actions: Pick<CaptureTransactionActions, 'addProject'>,
    options: CaptureTransactionOptions = {},
): Promise<CapturePreparationFailure | PreparedCaptureTask> {
    const plan = planCaptureTask(input, options);
    if (!plan.success) return plan;

    let props = plan.props;
    let createdProject: Project | undefined;
    if (plan.projectToCreate) {
        try {
            const created = await actions.addProject(
                plan.projectToCreate.title,
                plan.projectToCreate.color,
                plan.projectToCreate.initialProps,
            );
            if (!created) {
                return {
                    success: false,
                    reason: 'project-create-failed',
                    error: 'Failed to create project',
                };
            }
            createdProject = created;
            props = applyCapturedProject(props, created.id);
        } catch (error) {
            return {
                success: false,
                reason: 'project-create-failed',
                error: captureErrorMessage(error, 'Failed to create project'),
            };
        }
    }

    return {
        success: true,
        title: plan.title,
        props,
        invalidDateCommands: plan.invalidDateCommands,
        ...(createdProject ? { createdProject } : {}),
    };
}


export async function executeCaptureTransaction(
    input: CaptureAssemblyInput,
    actions: CaptureTransactionActions,
    options: CaptureTransactionOptions = {},
): Promise<CaptureTransactionResult> {
    const prepared = await prepareCaptureTask(input, actions, options);
    if (!prepared.success) return prepared;

    let taskResult: StoreActionResult;
    try {
        taskResult = await actions.addTask(prepared.title, prepared.props);
    } catch (error) {
        return {
            success: false,
            reason: 'task-create-failed',
            error: captureErrorMessage(error, 'Failed to create task'),
            title: prepared.title,
            props: prepared.props,
            ...(prepared.createdProject ? { createdProject: prepared.createdProject } : {}),
        };
    }

    if (!taskResult.success) {
        return {
            success: false,
            reason: 'task-create-failed',
            error: taskResult.error || 'Failed to create task',
            title: prepared.title,
            props: prepared.props,
            ...(prepared.createdProject ? { createdProject: prepared.createdProject } : {}),
        };
    }

    const createdTaskId = typeof taskResult.id === 'string' && taskResult.id.trim()
        ? taskResult.id
        : undefined;
    return {
        ...prepared,
        taskResult,
        ...(createdTaskId ? { createdTaskId } : {}),
    };
}
