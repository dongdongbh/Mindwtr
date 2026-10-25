import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createNativeHostContract, type NativeHostResult } from '../../../packages/core/src/native-host-contract';
import { buildReminderAlarmDetails } from '../../../packages/core/src/mobile-reminder-alarms';

// RN's 8f1af15a6 and 7439758fa: a review notification opens the review. On native Android a tap's data (CoreNotifications.kt puts
// the alarm's `data` in EXTRA_OPEN) goes to host-entry's notificationEntry, core's routeNotificationOpen picks the route, and
// EntryPoints.kt's go() opens it. This runs notificationEntry's own source with core's real contract, on the data core's alarm
// builder writes, and pins go()'s review branches.
const entry = readFileSync(new URL('./host-entry.ts', import.meta.url), 'utf8');
const start = entry.indexOf('const isNotificationTap = ');
const end = entry.indexOf('/** What an entry point opened, by kind only', start);
if (start < 0 || end < 0) throw new Error('notificationEntry unavailable');
const source = new Bun.Transpiler({ loader: 'ts' }).transformSync(`${entry.slice(start, end)}\nglobalThis.open = notificationEntry;`);
const fixture = () => {
    const host = createNativeHostContract();
    const events: string[] = [];
    const state = {
        NATIVE_HOST_CONTRACT_VERSION: 1, reminders: { event: () => events.push('plan') },
        contract: { routeNotificationOpen: (payload: Record<string, unknown>): NativeHostResult<unknown> => host.routeNotificationOpen(payload) },
        open: undefined as unknown as (input: { data?: unknown }) => { ok: boolean; value?: { route: string | null } },
    };
    vm.runInNewContext(source, state);
    return { open: state.open, events };
};
const tapped = (key: string) => ({ kind: 'notification', data: buildReminderAlarmDetails(key, { title: 'Review', body: 'Time' } as never).data });

describe('native Android notification taps', () => {
    it.each([
        ['the weekly review digest', 'digest:weekly-review', '/weekly-review'],
        ['the morning digest', 'digest:morning', '/daily-review'],
        ['the evening digest', 'digest:evening', '/daily-review'],
    ])('open %s from the data core\'s alarm builder writes', (_label, key, route) => {
        const f = fixture();
        expect(f.open(tapped(key))).toMatchObject({ ok: true, value: { route } });
        expect(f.events).toEqual([]);
    });

    it('opens the review a task review notification names', () => {
        const f = fixture();
        expect(f.open({ data: { kind: 'task-review', taskId: 't1', id: 'review:t1' } })).toMatchObject({ ok: true, value: { route: '/review-tab' } });
    });

    it('opens each review route in its review screen (EntryPoints.kt go)', () => {
        const points = readFileSync(new URL('../android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/EntryPoints.kt', import.meta.url), 'utf8');
        expect(points).toContain('route == "/daily-review" -> menu.openReview("daily")');
        expect(points).toContain('route == "/weekly-review" -> menu.openReview("weekly")');
        expect(points).toMatch(/getStringExtra\(CoreNotifications\.EXTRA_OPEN\)\?\.let \{ data -> return@runCatching JSONObject\(\)\.put\("kind", "notification"\)\.put\("data", JSONObject\(data\)\) \}/);
        const notifications = readFileSync(new URL('../android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/CoreNotifications.kt', import.meta.url), 'utf8');
        expect(notifications).toContain('.putExtra(EXTRA_OPEN, (details.optJSONObject("data") ?: JSONObject()).toString())');
    });
});
