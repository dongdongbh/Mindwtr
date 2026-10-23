// Pass D1c step 0 (code review 2): each importer's file, built by its encoded bytes so no text passes core's caps
// (import-source-reader.ts: 8 MiB per text or archive entry, 16 MiB expanded, 100 000 rows and entities), at most [tasks] tasks.
// Pure, so the caps are tested apart from the phone (data-transfer-limit.test.mjs).

/** Core's maxTextBytes and maxArchiveEntryBytes, less a margin for the line endings counted around them. */
export const IMPORT_TEXT_CAP_BYTES = 8 * 1024 * 1024 - 64 * 1024;
const MAX_ROWS = 100_000;
/** The library bytes one imported task adds: step 0 run 5's Todoist file grew the library 101 MiB with its 99 998 tasks. */
export const IMPORT_TASK_BYTES = 1024;
/** The same, per importer: step 0 run 6's 49 152-task files on a fresh install (the library grew 31.3 to 49.3 MiB). */
export const IMPORT_TASK_BYTES_BY_KEY = { todoist: 1050, ticktick: 900, dgt: 680, omnifocus: 670, 'mindwtr-csv': 710 };
/**
 * The task count whose import grows the library by about [mib] MiB at [taskBytes] per task (step 0 run 6 sizes each import to
 * the limit's range).
 */
export const importTasksFor = (mib, taskBytes = IMPORT_TASK_BYTES) => Math.max(1, Math.min(MAX_ROWS - 1, Math.round(mib * 1024 * 1024 / taskBytes)));

/** [header] then rows from [line] until the next row would pass [budget] bytes or [maxRows] rows; joined with "\n". */
const fill = (header, line, budget = IMPORT_TEXT_CAP_BYTES, maxRows = MAX_ROWS - 1) => {
    const rows = [header];
    let bytes = Buffer.byteLength(header);
    for (let index = 0; index < maxRows; index += 1) {
        const next = line(index);
        const size = Buffer.byteLength(next) + 1;
        if (bytes + size > budget) break;
        rows.push(next);
        bytes += size;
    }
    return rows.join('\n');
};
const csv = (cells) => cells.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(',');
const q = (count) => 'q'.repeat(count);

/**
 * Each importer's texts as `[entry name, text]` pairs: two archive members for Todoist (it reads every project CSV), else one.
 * Without [tasks], each is the largest core admits.
 */
export function importTexts(run, tasks = MAX_ROWS - 1) {
    return {
        // Two members of up to 8 MiB each, and together at most 100 000 tasks.
        todoist: [0, 1].map((part) => [`d1mtd${part}${run}.csv`, fill('TYPE,CONTENT,PRIORITY,INDENT,DATE,DESCRIPTION',
            (index) => `task,d1mtd${part}x${index} ${q(130)},1,1,,`, IMPORT_TEXT_CAP_BYTES, Math.min(MAX_ROWS / 2 - 1, Math.ceil(tasks / 2)))]),
        ticktick: [['backup.csv', fill(csv(['Folder Name', 'List Name', 'Title', 'Kind', 'Tags', 'Content', 'Is Check list', 'Start Date', 'Due Date',
            'Repeat', 'Priority', 'Status', 'Created Time', 'Completed Time', 'Timezone', 'Is All Day', 'taskId', 'parentId']),
        (index) => csv(['F', 'd1mtt', `d1mtt${index} ${q(14)}`, 'TEXT', '', '', 'N', '', '', '', '0', '0', '', '', 'UTC', 'false', String(index + 1), '']), IMPORT_TEXT_CAP_BYTES, tasks)]],
        dgt: [[`d1-measure-dgt-${tasks}-${run}.json`, (() => {
            const rows = [];
            // The JSON's own bytes: the wrapper plus each task and its comma.
            let bytes = Buffer.byteLength('{"version":3,"FOLDER":[{"ID":1,"TITLE":"d1mdgt","ORDINAL":0}],"TASK":[]}');
            for (let index = 0; index < Math.min(MAX_ROWS - 1, tasks); index += 1) {
                const task = { ID: index + 10, TYPE: 0, TITLE: `d1mdg${index} ${q(30)}`, STATUS: 0 };
                const size = Buffer.byteLength(JSON.stringify(task)) + 1;
                if (bytes + size > IMPORT_TEXT_CAP_BYTES) break;
                rows.push(task);
                bytes += size;
            }
            return JSON.stringify({ version: 3, FOLDER: [{ ID: 1, TITLE: 'd1mdgt', ORDINAL: 0 }], TASK: rows });
        })()]],
        omnifocus: [[`d1-measure-omnifocus-${tasks}-${run}.csv`, fill(csv(['Task ID', 'Type', 'Name', 'Status', 'Project', 'Context', 'Start Date', 'Planned Date',
            'Due Date', 'Completion Date', 'Duration', 'Flagged', 'Notes', 'Tags']),
        (index) => csv([`a${index}`, 'Action', `d1mof${index} ${q(20)}`, 'Available', '', '', '', '', '', '', '', '0', '', '']), IMPORT_TEXT_CAP_BYTES, tasks)]],
        'mindwtr-csv': [['tasks.csv', `${fill('Title', (index) => `d1mcsv${index} ${q(60)}`, IMPORT_TEXT_CAP_BYTES, tasks)}\n`]],
    };
}
