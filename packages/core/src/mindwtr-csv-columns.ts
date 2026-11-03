


export const MINDWTR_CSV_COLUMNS = [
    'Title', 'Description', 'Status', 'Project', 'Section', 'Area', 'Contexts', 'Tags',
    'Assigned To', 'Priority', 'Energy', 'Start Date', 'Due Date', 'Review Date',
    'Completed At', 'Checklist', 'Location', 'Order', 'ID', 'Created At', 'Recurrence',
    'Cancelled At',
] as const;

export type MindwtrCsvColumn = typeof MINDWTR_CSV_COLUMNS[number];

export const MINDWTR_CSV_KNOWN_COLUMNS: ReadonlySet<string> = new Set<string>(
    MINDWTR_CSV_COLUMNS.map((column) => column.toUpperCase()),
);


export const MINDWTR_CSV_FLUID_RECURRENCE_TOKEN = 'X-MINDWTR-STRATEGY=FLUID';
