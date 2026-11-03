


export const IMPORT_TEXT_CAP_BYTES = 8 * 1024 * 1024 - 64 * 1024;
const MAX_ROWS = 100_000;

export const IMPORT_TASK_BYTES = 1024;

export const IMPORT_TASK_BYTES_BY_KEY = { todoist: 1050, ticktick: 900, dgt: 680, omnifocus: 670, 'mindwtr-csv': 710 };


export const importTasksFor = (mib, taskBytes = IMPORT_TASK_BYTES) => Math.max(1, Math.min(MAX_ROWS - 1, Math.round(mib * 1024 * 1024 / taskBytes)));


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


export function importTexts(run, tasks = MAX_ROWS - 1) {
    return {

        todoist: [0, 1].map((part) => [`d1mtd${part}${run}.csv`, fill('TYPE,CONTENT,PRIORITY,INDENT,DATE,DESCRIPTION',
            (index) => `task,d1mtd${part}x${index} ${q(130)},1,1,,`, IMPORT_TEXT_CAP_BYTES, Math.min(MAX_ROWS / 2 - 1, Math.ceil(tasks / 2)))]),
        ticktick: [['backup.csv', fill(csv(['Folder Name', 'List Name', 'Title', 'Kind', 'Tags', 'Content', 'Is Check list', 'Start Date', 'Due Date',
            'Repeat', 'Priority', 'Status', 'Created Time', 'Completed Time', 'Timezone', 'Is All Day', 'taskId', 'parentId']),
        (index) => csv(['F', 'd1mtt', `d1mtt${index} ${q(14)}`, 'TEXT', '', '', 'N', '', '', '', '0', '0', '', '', 'UTC', 'false', String(index + 1), '']), IMPORT_TEXT_CAP_BYTES, tasks)]],
        dgt: [[`d1-measure-dgt-${tasks}-${run}.json`, (() => {
            const rows = [];

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
