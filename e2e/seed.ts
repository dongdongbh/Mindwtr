import type { Page } from '@playwright/test';

// The web build keeps the whole document under one localStorage key
// (apps/desktop/src/lib/storage-adapter-web.ts), so a fixture is one init
// script — the same seam app.spec.ts already uses for the onboarding flag.
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
};

export type SeedProject = {
    id: string;
    title: string;
};

export type SeedData = {
    tasks?: SeedTask[];
    projects?: SeedProject[];
    settings?: Record<string, unknown>;
};

/** A local `YYYY-MM-DD` key, the shape the app writes for date-only fields. */
export const localDateKey = (dayOffset = 0): string => {
    const date = new Date();
    date.setDate(date.getDate() + dayOffset);
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${date.getFullYear()}-${month}-${day}`;
};

/** Builds `count` tasks sharing one template, titled `<prefix> <n>`. */
export const seedTasks = (
    prefix: string,
    count: number,
    template: Omit<SeedTask, 'title' | 'id'>,
): SeedTask[] => Array.from({ length: count }, (_, index) => ({
    id: `${prefix.toLowerCase().replace(/\s+/g, '-')}-${index + 1}`,
    title: `${prefix} ${index + 1}`,
    ...template,
}));

/** Suppresses the first-run modal, as every pre-existing spec does. */
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

/** Writes a persisted document the app reads on startup. Call before goto. */
export const seedAppData = async (page: Page, data: SeedData): Promise<void> => {
    const payload = JSON.stringify({
        tasks: (data.tasks ?? []).map((task, index) => ({
            id: task.id ?? `seed-task-${index + 1}`,
            title: task.title,
            status: task.status,
            tags: [],
            contexts: [],
            createdAt: SEED_TIMESTAMP,
            updatedAt: SEED_TIMESTAMP,
            ...(task.dueDate ? { dueDate: task.dueDate } : {}),
            ...(task.startTime ? { startTime: task.startTime } : {}),
            ...(task.reviewAt ? { reviewAt: task.reviewAt } : {}),
            ...(task.isFocusedToday ? { isFocusedToday: true } : {}),
            ...(task.projectId ? { projectId: task.projectId } : {}),
        })),
        projects: (data.projects ?? []).map((project) => ({
            ...project,
            status: 'active',
            color: '#94a3b8',
            createdAt: SEED_TIMESTAMP,
            updatedAt: SEED_TIMESTAMP,
        })),
        sections: [],
        areas: [],
        people: [],
        settings: data.settings ?? {},
    });

    // Seed once per browser context: a later reload inside the same walk must
    // read what the app wrote, not the fixture again.
    await page.addInitScript(([key, value]) => {
        if (window.localStorage.getItem(key) == null) window.localStorage.setItem(key, value);
    }, [DATA_KEY, payload] as const);
};
