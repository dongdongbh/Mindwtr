// The device checks' shared start step: every live attachment whose file exists nowhere (on the phone and at any sync location)
// is removed by hand first. Since a remote "not found" keeps such a row (it never deletes it), one left by a cut-off run would
// stall every later switch of sync location on the missing-files question, whichever check made it.

/** A live file attachment with no file on this device (its title and owner), in live projects or tasks. */
const nowhere = (table) => `SELECT o.title AS owner, j.value->>'title' AS file FROM ${table} o, json_each(o.attachments) j `
    + "WHERE o.deletedAt IS NULL AND j.value->>'kind' = 'file' AND j.value->>'deletedAt' IS NULL "
    + "AND (j.value->>'localStatus' = 'missing' OR coalesce(j.value->>'uri', '') = '')";

/**
 * Removes each project file that exists nowhere with [removeProjectFile] (the check's Remove in project Details), refuses a task's
 * (no check makes one), and answers how many it removed. [query] runs SQL on a fresh pull of the phone's database.
 */
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
