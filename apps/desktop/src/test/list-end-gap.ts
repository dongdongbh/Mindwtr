import { expect } from 'vitest';
import { LIST_END_GAP } from '../components/views/list/list-toolbar';

const classList = (element: Element) => element.className.split(/\s+/).filter(Boolean);


export const expectScrolledEndGap = (container: HTMLElement) => {
    const gaps = Array.from(container.querySelectorAll('[data-list-end]'));
    expect(gaps.length).toBeGreaterThan(0);
    for (const gap of gaps) {
        expect(classList(gap)).toContain(LIST_END_GAP);
    }

    for (const viewport of container.querySelectorAll('[class*="overflow-y-auto"]')) {
        if (!viewport.querySelector('[data-list-end]')) continue;
        expect(classList(viewport).filter((name) => name.startsWith('pb-'))).toEqual([]);
    }
};
