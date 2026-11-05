import { beforeEach, describe, expect, it } from 'vitest';

import {
  CONTEXT_AUTOMATION_MAX_STARTS_PER_WINDOW,
  CONTEXT_AUTOMATION_RATE_WINDOW_MS,
  __resetContextAutomationDedupeForTests,
  wasContextAutomationRecentlyHandled,
} from './context-automation-handler';
import { parseContextAutomationHeadlessTaskData } from './context-automation-headless-task';

describe('context automation throttling', () => {
  beforeEach(() => {
    __resetContextAutomationDedupeForTests();
  });

  it('drops a repeat of the same context inside the dedupe window', () => {
    const payload = { action: 'activate', context: '@home' } as const;

    expect(wasContextAutomationRecentlyHandled(payload, 1_000)).toBe(false);
    expect(wasContextAutomationRecentlyHandled(payload, 5_000)).toBe(true);
    expect(wasContextAutomationRecentlyHandled(payload, 20_000)).toBe(false);
  });

  it('treats a bare context name and its @ token as one trigger', () => {

    expect(wasContextAutomationRecentlyHandled({ action: 'activate', context: 'home' }, 1_000)).toBe(false);
    expect(wasContextAutomationRecentlyHandled({ action: 'activate', context: '@home' }, 2_000)).toBe(true);
    expect(wasContextAutomationRecentlyHandled({ action: 'activate', context: ' #home ' }, 3_000)).toBe(true);
  });

  it('caps total starts per window even when every context differs', () => {


    const attempts = CONTEXT_AUTOMATION_MAX_STARTS_PER_WINDOW + 5;
    const handled = Array.from({ length: attempts }, (_unused, index) => (
      wasContextAutomationRecentlyHandled({ action: 'activate', context: `@ctx-${index}` }, 1_000 + index)
    ));

    expect(handled.filter((skipped) => !skipped)).toHaveLength(CONTEXT_AUTOMATION_MAX_STARTS_PER_WINDOW);
    expect(handled.slice(CONTEXT_AUTOMATION_MAX_STARTS_PER_WINDOW).every(Boolean)).toBe(true);
  });

  it('lets automation through again once the window has passed', () => {
    for (let index = 0; index < CONTEXT_AUTOMATION_MAX_STARTS_PER_WINDOW; index += 1) {
      wasContextAutomationRecentlyHandled({ action: 'activate', context: `@ctx-${index}` }, 1_000 + index);
    }

    expect(wasContextAutomationRecentlyHandled({ action: 'activate', context: '@blocked' }, 2_000)).toBe(true);
    expect(
      wasContextAutomationRecentlyHandled({ action: 'activate', context: '@allowed' }, 1_000 + CONTEXT_AUTOMATION_RATE_WINDOW_MS + 1)
    ).toBe(false);
  });
});

describe('parseContextAutomationHeadlessTaskData', () => {
  const cases: [string, unknown, { action: string; context: string } | null][] = [
    ['url wins over extras', { url: 'mindwtr://contexts?token=%40home&contextAction=activate', action: 'off', context: 'work' }, { action: 'activate', context: '@home' }],
    ['falls back to extras when the url is unparseable', { url: 'not a url', action: 'off', context: 'work' }, { action: 'deactivate', context: 'work' }],
    ['accepts the activate aliases', { action: 'ON', context: 'home' }, { action: 'activate', context: 'home' }],
    ['accepts the deactivate aliases', { action: ' Inactive ', context: 'home' }, { action: 'deactivate', context: 'home' }],
    ['rejects an unknown action', { action: 'toggle', context: 'home' }, null],
    ['rejects a blank context', { action: 'activate', context: '   ' }, null],
    ['rejects a missing action', { context: 'home' }, null],
    ['rejects empty data', {}, null],
    ['rejects null data', null, null],
  ];

  it.each(cases)('%s', (_name, data, expected) => {
    expect(parseContextAutomationHeadlessTaskData(data as never)).toEqual(expected);
  });
});
