// Pass D1c step 0 (code review 2): each importer's largest file core admits, built by its encoded bytes so no text passes core's
// caps (import-source-reader.ts: 8 MiB per text or archive entry, 16 MiB expanded, 100 000 rows and entities). Pure, so the
// caps are tested apart from the phone (data-transfer-limit.test.mjs).

/** Core's maxTextBytes and maxArchiveEntryBytes, less a margin for the line endings counted around them. */
export const IMPORT_TEXT_CAP_BYTES = 8 * 1024 * 1024 - 64 * 1024;
const MAX_ROWS = 100_000;

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

/** Each importer's texts as `[entry name, text]` pairs: two archive members for Todoist (it reads every project CSV), else one. */
export function importTexts(run) {
    return {
        // Two members of up to 8 MiB each, and together at most 100 000 tasks.
        todoist: [0, 1].map((part) => [`d1mtd${part}${run}.csv`, fill('TYPE,CONTENT,PRIORITY,INDENT,DATE,DESCRIPTION',
            (index) => `task,d1mtd${part}x${index} ${q(130)},1,1,,`, IMPORT_TEXT_CAP_BYTES, MAX_ROWS / 2 - 1)]),
        ticktick: [['backup.csv', fill(csv(['Folder Name', 'List Name', 'Title', 'Kind', 'Tags', 'Content', 'Is Check list', 'Start Date', 'Due Date',
            'Repeat', 'Priority', 'Status', 'Created Time', 'Completed Time', 'Timezone', 'Is All Day', 'taskId', 'parentId']),
        (index) => csv(['F', 'd1mtt', `d1mtt${index} ${q(14)}`, 'TEXT', '', '', 'N', '', '', '', '0', '0', '', '', 'UTC', 'false', String(index + 1), '']))]],
        dgt: [[`d1-measure-dgt-${run}.json`, (() => {
            const tasks = [];
            // The JSON's own bytes: the wrapper plus each task and its comma.
            let bytes = Buffer.byteLength('{"version":3,"FOLDER":[{"ID":1,"TITLE":"d1mdgt","ORDINAL":0}],"TASK":[]}');
            for (let index = 0; index < MAX_ROWS - 1; index += 1) {
                const task = { ID: index + 10, TYPE: 0, TITLE: `d1mdg${index} ${q(30)}`, STATUS: 0 };
                const size = Buffer.byteLength(JSON.stringify(task)) + 1;
                if (bytes + size > IMPORT_TEXT_CAP_BYTES) break;
                tasks.push(task);
                bytes += size;
            }
            return JSON.stringify({ version: 3, FOLDER: [{ ID: 1, TITLE: 'd1mdgt', ORDINAL: 0 }], TASK: tasks });
        })()]],
        omnifocus: [[`d1-measure-omnifocus-${run}.csv`, fill(csv(['Task ID', 'Type', 'Name', 'Status', 'Project', 'Context', 'Start Date', 'Planned Date',
            'Due Date', 'Completion Date', 'Duration', 'Flagged', 'Notes', 'Tags']),
        (index) => csv([`a${index}`, 'Action', `d1mof${index} ${q(20)}`, 'Available', '', '', '', '', '', '', '', '0', '', '']))]],
        'mindwtr-csv': [['tasks.csv', `${fill('Title', (index) => `d1mcsv${index} ${q(60)}`)}\n`]],
    };
}
