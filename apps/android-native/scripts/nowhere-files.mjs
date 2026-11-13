import { setTimeout as sleep } from 'node:timers/promises';
import { box, fail, inList, tab, tabSelected, tagged } from './device.mjs';




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


export const projectFiles = ({ device, en, toTabs, hideKeyboard }) => {
    const inProject = (nodes) => nodes.some((node) => /(^|\/)project-(title-input|details-[a-z]+|attachment-add-link)$/.test(node['resource-id'] ?? ''));
    const projectList = async () => {
        let nodes = await device.projectsTab(toTabs);
        nodes = await device.tapExpecting(tab(nodes, en['nav.projects']), (current) => tabSelected(current, en['nav.projects']), 'Projects');
        for (let step = 0; step < 4 && inProject(nodes); step += 1) {
            await hideKeyboard();
            device.requireAppFront();
            device.sh('input keyevent KEYCODE_BACK');
            await sleep(1000);
            nodes = await device.screen();
        }
        return inProject(nodes) ? fail('the project list did not come back') : nodes;
    };
    const removeProjectFile = async (project, file) => {
        await projectList();
        let nodes = await device.reveal(project);
        nodes = await device.tapExpecting(inList(nodes, project) ?? fail(`no project row ${project}`), (current) => Boolean(tagged(current, 'project-details-toggle')), 'the project');
        if (!tagged(nodes, 'project-attachment-add-link')) {
            nodes = await device.tapExpecting(tagged(nodes, 'project-details-toggle'), (current) => Boolean(tagged(current, 'project-attachment-add-link')), 'the project Details');
        }
        const row = await device.revealNode((current) => current.find((node) => node.text === file), file, false);
        nodes = await device.screen();
        const [, top, , bottom] = box(row);
        const remove = nodes.find((node) => node.text === en['attachments.remove'] && box(node)[1] <= (top + bottom) / 2 && box(node)[3] >= (top + bottom) / 2);
        await device.tapExpecting(remove ?? fail(`no Remove beside ${file}`), (current) => !current.some((node) => node.text === file), `${file} removed`);
        await projectList();
    };
    return { projectList, removeProjectFile };
};
