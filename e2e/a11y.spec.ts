import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { THEME_DESCRIPTORS } from '../packages/core/src/theme-scheme';
import { dismissOnboarding, localDateKey, seedAppData, seedTheme } from './seed';

const axeSource = readFileSync('node_modules/axe-core/axe.min.js', 'utf8');

// Read off core's registry rather than hand-listed, so an eleventh AppTheme is
// gated the day it is added. `system` is excluded because it renders as one of
// these; `material3-*` ship no desktop CSS and collapse to plain light/dark
// (apps/desktop/src/lib/theme.ts), which is itself worth measuring.
const THEMES = Object.keys(THEME_DESCRIPTORS);

// Enough content for the status, project and focus colors to render on all
// three screens, and small enough to keep each theme's walk short.
const FIXTURE = {
    projects: [{ id: 'a11y-project', title: 'Contrast Fixture' }],
    tasks: [
        { id: 'a11y-inbox', title: 'A11y inbox capture', status: 'inbox' as const },
        { id: 'a11y-due', title: 'A11y due today', status: 'next' as const, dueDate: localDateKey(0), projectId: 'a11y-project' },
        { id: 'a11y-waiting', title: 'A11y waiting item', status: 'waiting' as const },
        { id: 'a11y-focus', title: 'A11y focus item', status: 'next' as const, isFocusedToday: true },
    ],
};

type ContrastViolation = {
    key: string;
    detail: string;
};

/**
 * Contrast failures that already existed when this gate was widened over every
 * theme and onto Settings and the Daily Review (2026-09-04).
 *
 * The key is `theme | rule | foreground on background`, NOT the DOM selector
 * axe reports: the debt is a color token, one token shows up under a dozen
 * class-chain selectors that change with any unrelated markup edit, and one
 * token fix clears every node at once. The list may only shrink — fix the
 * token, delete the line. The stale-entry test below fails on an entry that no
 * longer fires, so a fix cannot quietly leave the door open again.
 */
const KNOWN_CONTRAST_VIOLATIONS = new Set<string>([
    // Status chips: the status hue on its own 14% tint, just under 4.5:1.
    'light | color-contrast | #228145 on #e0ede5',
    'light | color-contrast | #9d6607 on #f1eadc',
    'material3-light | color-contrast | #228145 on #e0ede5',
    'material3-light | color-contrast | #9d6607 on #f1eadc',
    'dark | color-contrast | #5593f7 on #253042',
    'material3-dark | color-contrast | #5593f7 on #253042',
    'nord | color-contrast | #77c591 on #3f4f55',
    'nord | color-contrast | #77c591 on #43545b',
    'sepia | color-contrast | #3e743e on #dbdbc2',
    'sepia | color-contrast | #3e743e on #dee0c9',
    'sepia | color-contrast | #3e743e on #e0e1cc',
    'sepia | color-contrast | #855e33 on #e4d8c1',
    'sepia | color-contrast | #855e33 on #efe2c7',
    'sepia | color-contrast | #886134 on #e5d9c1',
    'sepia | color-contrast | #886134 on #e9dec8',
    'catppuccin-macchiato | color-contrast | #a5adcb on #494d64',
    'dracula | color-contrast | #bd93f9 on #3b3c4f',
    // Metadata info badge: the amber status hue on the plain muted surface.
    'light | color-contrast | #9d6607 on #f1f5f9',
    'material3-light | color-contrast | #9d6607 on #f1f5f9',
    // Settings onboarding hint: primary text on the primary 10% tint.
    'light | color-contrast | #0b64f4 on #e7f0fe',
    'material3-light | color-contrast | #0b64f4 on #e7f0fe',
]);

const seenViolationKeys = new Set<string>();

type AxeContrastNode = {
    selector: string;
    fgColor: string;
    bgColor: string;
    contrastRatio: number;
};

const runAxeContrast = async (page: Page, theme: string, context: string): Promise<ContrastViolation[]> => {
    await page.addScriptTag({ content: axeSource });
    const nodes = await page.evaluate(async () => {
        type CheckResult = { id: string; data?: Record<string, unknown> };
        const results = await (window as unknown as {
            axe: {
                run: (
                    context: Document,
                    options: { runOnly: { type: 'rule'; values: string[] } }
                ) => Promise<{
                    violations: Array<{
                        id: string;
                        nodes: Array<{ target: string[]; any?: CheckResult[]; all?: CheckResult[] }>;
                    }>;
                }>;
            };
        }).axe.run(document, { runOnly: { type: 'rule', values: ['color-contrast'] } });

        return results.violations.flatMap((violation) => violation.nodes.map((node) => {
            const data = [...(node.any ?? []), ...(node.all ?? [])]
                .find((check) => check.id === 'color-contrast')?.data ?? {};
            return {
                rule: violation.id,
                selector: node.target.join(' '),
                fgColor: String(data.fgColor ?? 'unknown'),
                bgColor: String(data.bgColor ?? 'unknown'),
                contrastRatio: Number(data.contrastRatio ?? 0),
            };
        }));
    });

    return nodes.map(({ rule, selector, fgColor, bgColor, contrastRatio }: AxeContrastNode & { rule: string }) => {
        const key = `${theme} | ${rule} | ${fgColor} on ${bgColor}`;
        seenViolationKeys.add(key);
        return { key, detail: `${key} — ratio ${contrastRatio} at ${context} ${selector}` };
    });
};

const openDailyReview = async (page: Page) => {
    const reviewNav = page.locator('[data-sidebar-item][data-view="review"]');
    await reviewNav.click();
    await page.getByRole('button', { name: 'Daily Review', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Daily Review' })).toBeVisible();
};

for (const theme of THEMES) {
    test(`no color contrast violations in the ${theme} theme`, async ({ page }) => {
        // Three screens and three axe passes in one browser context: past the
        // default per-test budget, well inside the job's.
        test.slow();
        await dismissOnboarding(page);
        await seedTheme(page, theme);
        await seedAppData(page, { ...FIXTURE, settings: { theme } });

        const found: ContrastViolation[] = [];

        await page.goto('/');
        await expect(page.locator('[data-sidebar-item][data-view="agenda"]')).toBeVisible();
        found.push(...await runAxeContrast(page, theme, 'focus'));

        // Settings is code-split, so wait for its own heading, not the shell.
        await page.goto('/?view=settings');
        await expect(page.getByRole('heading', { name: 'General', level: 2 })).toBeVisible();
        found.push(...await runAxeContrast(page, theme, 'settings'));

        await openDailyReview(page);
        found.push(...await runAxeContrast(page, theme, 'daily-review'));

        const unlisted = [...new Set(
            found
                .filter((violation) => !KNOWN_CONTRAST_VIOLATIONS.has(violation.key))
                .map((violation) => violation.detail),
        )];
        expect(unlisted).toEqual([]);
    });
}

// Without this the allowlist rots: an entry left behind after its token is fixed
// quietly re-opens the door for that contrast failure to come back. It reads what
// the theme tests above recorded, which needs them in this worker — the default
// (`fullyParallel` off) keeps one file on one worker; turning that on would make
// this fail loudly rather than pass on nothing.
test('keeps no stale entries in the known contrast violations', () => {
    expect([...KNOWN_CONTRAST_VIOLATIONS].filter((key) => !seenViolationKeys.has(key))).toEqual([]);
});
