


const nowhere = (table) => `SELECT o.title AS owner, j.value->>'title' AS file FROM ${table} o, json_each(o.attachments) j `
    + "WHERE o.deletedAt IS NULL AND j.value->>'kind' = 'file' AND j.value->>'deletedAt' IS NULL "
    + "AND (j.value->>'localStatus' = 'missing' OR coalesce(j.value->>'uri', '') = '')";


export const removeNowhereFiles = async ({ query, removeProjectFile, log = console.log }) => {
    const tasks = query(nowhere('tasks'));
    if (tasks.length) throw new Error(`a task file exists nowhere (${tasks.length}); remove it in the task editor first`);
    const projects = query(nowhere('projects'));
    for (const { owner, file } of projects) {
        log(`note - removing a file that exists nowhere, left by an earlier run: ${file} (${owner})`);
        await removeProjectFile(owner, file);
    }
    const left = query(nowhere('projects')).length;
    if (left) throw new Error(`${left} project file(s) that exist nowhere are still there`);
    return projects.length;
};
