import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { THEME_DESCRIPTORS } from '../packages/core/src/theme-scheme';
import { dismissOnboarding, localDateKey, seedAppData, seedTheme } from './seed';

const axeSource = readFileSync('node_modules/axe-core/axe.min.js', 'utf8');


const THEMES = Object.keys(THEME_DESCRIPTORS);


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


const KNOWN_CONTRAST_VIOLATIONS = new Set<string>([

    'light | color-contrast | #228145 on #e0ede5',
    'material3-light | color-contrast | #228145 on #e0ede5',
    'nord | color-contrast | #77c591 on #3f4f55',
    'nord | color-contrast | #77c591 on #43545b',
    'sepia | color-contrast | #3e743e on #dbdbc2',
    'sepia | color-contrast | #3e743e on #dee0c9',
    'sepia | color-contrast | #3e743e on #e0e1cc',
    'sepia | color-contrast | #855e33 on #efe2c7',
    'sepia | color-contrast | #886134 on #e9dec8',
    'catppuccin-macchiato | color-contrast | #a5adcb on #494d64',
    'dracula | color-contrast | #bd93f9 on #3b3c4f',

    'light | color-contrast | #9d6607 on #f1f5f9',
    'material3-light | color-contrast | #9d6607 on #f1f5f9',

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


        test.slow();

        if (theme === 'system-oled') await page.emulateMedia({ colorScheme: 'light' });
        const contrastTheme = theme === 'system-oled' ? 'light' : theme;
        await dismissOnboarding(page);
        await seedTheme(page, theme);
        await seedAppData(page, { ...FIXTURE, settings: { theme } });

        const found: ContrastViolation[] = [];

        await page.goto('/');

        await page.locator('#main-content').waitFor({ state: 'visible', timeout: 15_000 });
        await expect(page.locator('[data-sidebar-item][data-view="agenda"]')).toBeVisible();
        found.push(...await runAxeContrast(page, contrastTheme, 'focus'));


        await page.goto('/?view=settings');
        await page.locator('#main-content').waitFor({ state: 'visible', timeout: 15_000 });
        await expect(page.getByRole('heading', { name: 'General', level: 2 })).toBeVisible();
        found.push(...await runAxeContrast(page, contrastTheme, 'settings'));

        await openDailyReview(page);
        found.push(...await runAxeContrast(page, contrastTheme, 'daily-review'));

        const unlisted = [...new Set(
            found
                .filter((violation) => !KNOWN_CONTRAST_VIOLATIONS.has(violation.key))
                .map((violation) => violation.detail),
        )];
        expect(unlisted).toEqual([]);
    });
}


test('keeps no stale entries in the known contrast violations', () => {
    expect([...KNOWN_CONTRAST_VIOLATIONS].filter((key) => !seenViolationKeys.has(key))).toEqual([]);
});
