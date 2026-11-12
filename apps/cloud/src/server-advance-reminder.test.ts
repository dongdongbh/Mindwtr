import { describe, expect, test } from 'bun:test';
import { validateAppData, validateEntityProps } from './server-validation';

const task = { id: 'advance', title: 'Advance', status: 'next', tags: [], contexts: [], createdAt: '2026-10-24T12:00:00.000Z', updatedAt: '2026-10-24T12:00:00.000Z' };
const document = (lead: unknown) => ({ tasks: [{ ...task, dueReminderLeadMinutes: lead }], projects: [], sections: [], areas: [], settings: {} });

describe('advance reminder trust boundaries', () => {
    test('allows old documents, explicit clear, and bounded minute values', () => {
        for (const lead of [undefined, null, 0, 1, 5, 1440, 10080]) {
            expect(validateAppData(document(lead)).ok).toBe(true);
            expect(validateEntityProps('task', 'create', { dueReminderLeadMinutes: lead }).ok).toBe(true);
            expect(validateEntityProps('task', 'patch', { dueReminderLeadMinutes: lead }).ok).toBe(true);
        }
    });
    test('rejects invalid offsets before REST and sync document writes', () => {
        for (const lead of [-1, 1.5, 10081, Infinity, NaN, '15', true]) {
            expect(validateAppData(document(lead)).ok).toBe(false);
            expect(validateEntityProps('task', 'create', { dueReminderLeadMinutes: lead }).ok).toBe(false);
            expect(validateEntityProps('task', 'patch', { dueReminderLeadMinutes: lead }).ok).toBe(false);
        }
    });
});

describe('start advance reminder trust boundaries', () => {
    test('allows old documents, explicit clear, and bounded minute values', () => {
        for (const lead of [undefined, null, 0, 5, 15, 30, 60]) {
            expect(validateAppData({ ...document(undefined), tasks: [{ ...task, startReminderLeadMinutes: lead }] }).ok).toBe(true);
            expect(validateEntityProps('task', 'create', { startReminderLeadMinutes: lead }).ok).toBe(true);
            expect(validateEntityProps('task', 'patch', { startReminderLeadMinutes: lead }).ok).toBe(true);
        }
    });
    test('rejects invalid offsets before REST and sync document writes', () => {
        for (const lead of [-1, 1, 1.5, 61, 1440, Infinity, NaN, '15', true]) {
            expect(validateAppData({ ...document(undefined), tasks: [{ ...task, startReminderLeadMinutes: lead }] }).ok).toBe(false);
            expect(validateEntityProps('task', 'create', { startReminderLeadMinutes: lead }).ok).toBe(false);
            expect(validateEntityProps('task', 'patch', { startReminderLeadMinutes: lead }).ok).toBe(false);
        }
    });
});


describe('task reminder policy trust boundaries', () => {
    test('accepts all policies and legacy absence for REST and sync documents', () => {
        for (const reminderPolicy of [undefined, null, 'inherit', 'send', 'skip', 'start', 'due']) {
            expect(validateAppData({ ...document(undefined), tasks: [{ ...task, reminderPolicy }] }).ok).toBe(true);
            expect(validateEntityProps('task', 'create', { reminderPolicy }).ok).toBe(true);
            expect(validateEntityProps('task', 'patch', { reminderPolicy }).ok).toBe(true);
        }
    });
    test('rejects malformed policies before REST and sync document writes', () => {
        for (const reminderPolicy of ['', 'sometimes', 1, true, {}, []]) {
            expect(validateAppData({ ...document(undefined), tasks: [{ ...task, reminderPolicy }] }).ok).toBe(false);
            expect(validateEntityProps('task', 'create', { reminderPolicy }).ok).toBe(false);
            expect(validateEntityProps('task', 'patch', { reminderPolicy }).ok).toBe(false);
        }
    });
});
