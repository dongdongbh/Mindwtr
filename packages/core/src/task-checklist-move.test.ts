import {describe,it,expect} from 'vitest';
import {canMoveTaskToChecklist,getChecklistMoveTargets,checklistItemIdForMovedTask} from './task-checklist-move';
import type {Task} from './types';
const at='2026-11-02T12:00:00.000Z',task=(id:string,patch:Partial<Task>={}):Task=>({id,title:id,status:'inbox',tags:[],contexts:[],createdAt:at,updatedAt:at,...patch});
describe('canonical title-only eligibility and deterministic identity',()=>{
    it('retains every donor detail guard and the explicit newer-field compatibility guard',()=>{
        const patches:Partial<Task>[]=[{status:'next'},{deletedAt:at},{purgedAt:at},{title:' '},{description:'note'},{attachments:[{id:'a',kind:'link',title:'a',uri:'https://example.com',createdAt:at}]},{checklist:[{id:'x',title:'x',isCompleted:false}]},
            {startTime:at},{dueDate:at},{reviewAt:at},{recurrence:{rule:'daily'}},{relativeStartOffset:{amount:1,unit:'days'}},{contexts:['@a']},{tags:['#a']},{projectId:'p'},{sectionId:'s'},
            {priority:'high'},{energyLevel:'low'},{timeEstimate:'15min'},{assignedTo:'Sam'},{location:'Home'},{timeSpentMinutes:5},{repeatReminderMinutes:10},{reminderPolicy:'send'}];
        expect(canMoveTaskToChecklist(task('source'))).toBe(true);for(const patch of patches)expect(canMoveTaskToChecklist(task('source',patch)),JSON.stringify(patch)).toBe(false);
        expect(canMoveTaskToChecklist(task('source'),null,{dueReminderLeadMinutes:30})).toBe(false);expect(canMoveTaskToChecklist(task('source'),null,{dueReminderLeadMinutes:0})).toBe(true);expect(canMoveTaskToChecklist(task('source'),null,{dueReminderLeadMinutes:null})).toBe(true);
        expect(canMoveTaskToChecklist(task('source',{areaId:'default'}),'default')).toBe(true);expect(canMoveTaskToChecklist(task('source',{areaId:'other'}),'default')).toBe(false);
    });
    it('prefers existing checklists and keeps Unicode identities literal',()=>{const rows=[task('source'),task('plain',{title:'Packing'}),task('list',{title:'Packing list',checklist:[{id:'x',title:'x',isCompleted:false}]}),task('closed',{status:'done'})];
        expect(getChecklistMoveTargets(rows,'source',' PACK ').map(row=>row.id)).toEqual(['list','plain']);expect(checklistItemIdForMovedTask('e\u0301')).not.toBe(checklistItemIdForMovedTask('é'));expect(checklistItemIdForMovedTask('源')).toMatch(/^[0-9a-f-]{36}$/);
    });
});
