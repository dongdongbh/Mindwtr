import type { Page } from '@playwright/test';
import type { Attachment } from '@mindwtr/core';


const DATA_KEY = 'mindwtr-data';
const ONBOARDING_KEY = 'mindwtr:desktop:first-run-onboarding:v1';
const THEME_KEY = 'mindwtr-theme';
const SEED_TIMESTAMP = '2020-01-01T00:00:00.000Z';

export type SeedTaskStatus = 'inbox' | 'next' | 'waiting' | 'someday' | 'done' | 'reference';

export type SeedTask = {
    id?: string;
    title: string;
    status: SeedTaskStatus;
    dueDate?: string;
    startTime?: string;
    reviewAt?: string;
    isFocusedToday?: boolean;
    projectId?: string;
    contexts?: string[];
    areaId?: string;
    attachments?: Attachment[];
};

export type SeedProject = {
    id: string;
    title: string;
    areaId?: string;
};

export type SeedData = {
    tasks?: SeedTask[];
    projects?: SeedProject[];
    areas?: { id: string; name: string }[];
    settings?: Record<string, unknown>;
};


export const localDateKey = (dayOffset = 0): string => {
    const date = new Date();
    date.setDate(date.getDate() + dayOffset);
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${date.getFullYear()}-${month}-${day}`;
};


export const seedTasks = (
    prefix: string,
    count: number,
    template: Omit<SeedTask, 'title' | 'id'>,
): SeedTask[] => Array.from({ length: count }, (_, index) => ({
    id: `${prefix.toLowerCase().replace(/\s+/g, '-')}-${index + 1}`,
    title: `${prefix} ${index + 1}`,
    ...template,
}));


export const dismissOnboarding = async (page: Page): Promise<void> => {
    await page.addInitScript((key) => {
        window.localStorage.setItem(key, 'dismissed');
    }, ONBOARDING_KEY);
};

export const seedTheme = async (page: Page, theme: string): Promise<void> => {
    await page.addInitScript(([key, value]) => {
        window.localStorage.setItem(key, value);
    }, [THEME_KEY, theme] as const);
};


export const seedAppData = async (page: Page, data: SeedData): Promise<void> => {
    const payload = JSON.stringify({
        tasks: (data.tasks ?? []).map((task, index) => ({
            id: task.id ?? `seed-task-${index + 1}`,
            title: task.title,
            status: task.status,
            tags: [],
            contexts: task.contexts ?? [],
            createdAt: SEED_TIMESTAMP,
            updatedAt: SEED_TIMESTAMP,
            ...(task.dueDate ? { dueDate: task.dueDate } : {}),
            ...(task.startTime ? { startTime: task.startTime } : {}),
            ...(task.reviewAt ? { reviewAt: task.reviewAt } : {}),
            ...(task.isFocusedToday ? { isFocusedToday: true } : {}),
            ...(task.projectId ? { projectId: task.projectId } : {}),
            ...(task.areaId ? { areaId: task.areaId } : {}),
            ...(task.attachments ? { attachments: task.attachments } : {}),
        })),
        projects: (data.projects ?? []).map((project) => ({
            ...project,
            status: 'active',
            color: '#94a3b8',
            createdAt: SEED_TIMESTAMP,
            updatedAt: SEED_TIMESTAMP,
        })),
        sections: [],
        areas: (data.areas ?? []).map((area) => ({
            ...area,
            createdAt: SEED_TIMESTAMP,
            updatedAt: SEED_TIMESTAMP,
        })),
        people: [],
        settings: data.settings ?? {},
    });


    await page.addInitScript(([key, value]) => {
        if (window.localStorage.getItem(key) == null) window.localStorage.setItem(key, value);
    }, [DATA_KEY, payload] as const);
};
