import { MINDWTR_CSV_COLUMNS, MINDWTR_CSV_FLUID_RECURRENCE_TOKEN } from './mindwtr-csv-columns';
import { buildRRuleString, normalizeRecurrenceForLoad, parseRRuleString } from './recurrence';
import type { AppData, Task } from './types';


export interface MindwtrCsvExportOptions {

    delimiter?: string;


    tasks?: readonly Task[];
}

const isLive = (entity: { deletedAt?: string; purgedAt?: string }): boolean => (
    !entity.deletedAt && !entity.purgedAt
);


const escapeCell = (value: string, delimiter: string): string => (
    new RegExp(`["\\n\\r${delimiter.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}]`, 'u').test(value)
        ? `"${value.replace(/"/gu, '""')}"`
        : value
);

const formatChecklist = (task: Task): string => (task.checklist ?? [])
    .map((item) => `[${item.isCompleted ? 'x' : ' '}] ${item.title}`)
    .join('|');


const formatRecurrence = (task: Task): string => {
    const recurrence = normalizeRecurrenceForLoad(task.recurrence);
    if (!recurrence) return '';
    const rrule = buildRRuleString(
        recurrence.rule,
        recurrence.byDay,
        parseRRuleString(recurrence.rrule ?? '').interval,
        {
            byMonthDay: recurrence.byMonthDay,
            weekStart: recurrence.weekStart,
            count: recurrence.count,
            until: recurrence.until,
        },
    );
    return recurrence.strategy === 'fluid' ? `${rrule};${MINDWTR_CSV_FLUID_RECURRENCE_TOKEN}` : rrule;
};

export function serializeMindwtrCsv(data: AppData, options: MindwtrCsvExportOptions = {}): string {
    const delimiter = options.delimiter ?? ',';
    const projectById = new Map(data.projects.filter(isLive).map((project) => [project.id, project]));
    const sectionById = new Map(data.sections.filter(isLive).map((section) => [section.id, section]));
    const areaById = new Map(data.areas.filter(isLive).map((area) => [area.id, area]));

    const cellsFor = (task: Task): Record<string, string> => {
        const project = task.projectId ? projectById.get(task.projectId) : undefined;
        const section = task.sectionId ? sectionById.get(task.sectionId) : undefined;


        const area = areaById.get(project?.areaId ?? task.areaId ?? '');
        return {
            'Title': task.title,
            'Description': task.description ?? '',
            'Status': task.status,
            'Project': project?.title ?? '',


            'Section': project ? section?.title ?? '' : '',
            'Area': area?.name ?? '',
            'Contexts': (task.contexts ?? []).join(', '),
            'Tags': (task.tags ?? []).join(', '),
            'Assigned To': task.assignedTo ?? '',
            'Priority': task.priority ?? '',
            'Energy': task.energyLevel ?? '',
            'Start Date': task.startTime ?? '',
            'Due Date': task.dueDate ?? '',
            'Review Date': task.reviewAt ?? '',
            'Completed At': task.completedAt ?? '',
            'Cancelled At': task.cancelledAt ?? '',
            'Checklist': formatChecklist(task),
            'Location': task.location ?? '',
            'Order': String(task.order ?? 0),
            'ID': task.id,
            'Created At': task.createdAt,
            'Recurrence': formatRecurrence(task),
        };
    };

    const rows = (options.tasks ?? data.tasks)
        .filter(isLive)
        .map((task) => {
            const cells = cellsFor(task);
            return MINDWTR_CSV_COLUMNS.map((column) => escapeCell(cells[column] ?? '', delimiter)).join(delimiter);
        });

    return [MINDWTR_CSV_COLUMNS.join(delimiter), ...rows].join('\n');
}
