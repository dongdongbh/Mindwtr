import { DEFAULT_PROJECT_COLOR } from './color-constants';
import { isSelectableProjectForTaskAssignment } from './project-utils';
import type { QuickAddResult } from './quick-add';
import type { Area, Project, Section, Task } from './types';

export type CaptureDestination =
    | { kind: 'none' }
    | { kind: 'area'; id: string }
    | { kind: 'project'; id: string; sectionId?: string };

export type CaptureDestinationSnapshot = { destination: CaptureDestination; projectToCreate?: { title: string } };

export function readCaptureDestinationSnapshot(value: unknown): CaptureDestinationSnapshot | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const destination = readCaptureDestination(record.destination);
    if (!destination || Object.keys(record).some(field => field !== 'destination' && field !== 'projectToCreate')) return null;
    if (record.projectToCreate === undefined) return { destination };
    const creation = record.projectToCreate;
    if (destination.kind === 'project' || !creation || typeof creation !== 'object' || Array.isArray(creation)
        || Object.keys(creation).length !== 1 || !('title' in creation) || typeof creation.title !== 'string'
        || !creation.title.trim() || creation.title.length > 1000) return null;
    return { destination, projectToCreate: { title: creation.title } };
}

export function readCaptureDestination(value: unknown): CaptureDestination | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const validId = (id: unknown): id is string => typeof id === 'string' && id.length > 0 && id.length <= 500 && id.trim() === id;
    const fields = Object.keys(record);
    if (record.kind === 'none' && fields.length === 1) return { kind: 'none' };
    if (!validId(record.id)) return null;
    if (record.kind === 'area' && fields.length === 2) return { kind: 'area', id: record.id };
    if (record.kind !== 'project' || !fields.every(field => ['kind', 'id', 'sectionId'].includes(field))) return null;
    if (record.sectionId !== undefined && !validId(record.sectionId)) return null;
    return { kind: 'project', id: record.id, ...(typeof record.sectionId === 'string' ? { sectionId: record.sectionId } : {}) };
}

export function isCaptureDestinationAvailable(destination: CaptureDestination, data: {
    projects: readonly Project[]; areas?: readonly Area[]; sections?: readonly Section[];
}): boolean {
    if (destination.kind === 'none') return true;
    if (destination.kind === 'area') return Boolean(data.areas?.some(area => area.id === destination.id && !area.deletedAt));
    return data.projects.some(project => project.id === destination.id && isSelectableProjectForTaskAssignment(project))
        && (!destination.sectionId || Boolean(data.sections?.some(section => section.id === destination.sectionId
            && section.projectId === destination.id && !section.deletedAt)));
}

export function captureDestinationProps(destination: CaptureDestination): Partial<Task> {
    return {
        projectId: destination.kind === 'project' ? destination.id : undefined,
        sectionId: destination.kind === 'project' ? destination.sectionId : undefined,
        areaId: destination.kind === 'area' ? destination.id : undefined,
    };
}

export function resolveCaptureDestination(input: {
    parsed: Pick<QuickAddResult, 'props' | 'projectTitle'>;
    projects: readonly Project[]; areas?: readonly Area[]; sections?: readonly Section[];
    initialProps?: Partial<Task>; selectedAreaId?: string | null; destination?: CaptureDestination;
}) {
    const { parsed, initialProps } = input;
    let destination = input.destination;
    let projectToCreate: { title: string; color: string; initialProps?: Partial<Project> } | undefined;
    if (!destination) {
        if (parsed.props.projectId) destination = { kind: 'project', id: parsed.props.projectId };
        else if (parsed.projectTitle) {
            const match = input.projects.find(project => project.title.toLowerCase() === parsed.projectTitle!.toLowerCase()
                && isSelectableProjectForTaskAssignment(project));
            if (match) destination = { kind: 'project', id: match.id };
            else {
                const areaId = parsed.props.areaId || initialProps?.areaId || input.selectedAreaId || undefined;
                destination = areaId ? { kind: 'area', id: areaId } : { kind: 'none' };
                projectToCreate = { title: parsed.projectTitle, color: DEFAULT_PROJECT_COLOR, ...(areaId ? { initialProps: { areaId } } : {}) };
            }
        } else if (parsed.props.areaId) destination = { kind: 'area', id: parsed.props.areaId };
        else if (initialProps?.projectId) destination = { kind: 'project', id: initialProps.projectId,
            ...(initialProps.sectionId ? { sectionId: initialProps.sectionId } : {}) };
        else {
            const areaId = initialProps?.areaId || input.selectedAreaId;
            destination = areaId ? { kind: 'area', id: areaId } : { kind: 'none' };
        }
    }
    return { destination, projectToCreate, available: isCaptureDestinationAvailable(destination, input) };
}
