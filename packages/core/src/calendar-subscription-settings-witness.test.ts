import { describe, expect, it } from 'vitest';
import { calendarSubscriptionSettingSource, planCalendarSubscriptionSetting, CALENDAR_SUBSCRIPTION_SOURCE_BYTES } from './calendar-subscription-settings-witness';
import type { AppSettings } from './types';

const AT = '2026-10-09T10:00:00.000Z';
const feed = { id: 'feed-a', name: 'Private calendar', url: 'https://person:secret@example.invalid/calendar?token=private',
    enabled: true, color: '#2563EB', areaIds: ['dangling', 'area-a'], retained: { exact: ['keep'] } };
const settings = (): AppSettings => ({ externalCalendars: [feed], syncPreferencesUpdatedAt: { externalCalendars: AT } });

describe('calendar subscription saved-source witness and metadata plan', () => {
    it('binds complete canonical content despite unchanged stamp, preserving raw fields and ignoring legacy', () => {
        const first = calendarSubscriptionSettingSource(settings(), null)!;
        const same = calendarSubscriptionSettingSource(settings(), 'malformed private legacy data')!;
        expect(first.witness).toEqual(same.witness);
        expect(first.witness).toMatchObject({ source: 'canonical', revision: `synced:${AT}`, stampPresent: true, stamp: AT });
        expect(first.witness.fingerprint).toMatch(/^[0-9a-f]{64}$/);
        const changed = settings(); changed.externalCalendars![0] = { ...feed, url: 'https://different.invalid' };
        expect(calendarSubscriptionSettingSource(changed, null)!.witness.fingerprint).not.toBe(first.witness.fingerprint);
        const planned = planCalendarSubscriptionSetting(first.feeds,
            { type: 'feed', feedId: 'feed-a', field: 'enabled', value: false, revision: first.witness.revision });
        expect(planned).toEqual({ changed: true, feeds: [{ ...feed, enabled: false }] });
        expect(first.feeds).toEqual([feed]);
        first.feeds[0].areaIds!.push('local');
        expect(settings().externalCalendars![0].areaIds).toEqual(['dangling', 'area-a']);
    });

    it('keeps canonical empty authoritative and binds exact legacy bytes without generating identities', () => {
        expect(calendarSubscriptionSettingSource({ externalCalendars: [] }, JSON.stringify([feed]))!.feeds).toEqual([]);
        const raw = JSON.stringify([{ ...feed, name: ' Calendar ', url: ' https://example.invalid ', retained: undefined }]);
        const first = calendarSubscriptionSettingSource({}, raw)!;
        expect(first.witness.source).toBe('legacy');
        expect(first.feeds).toEqual([{ id: feed.id, name: 'Calendar', url: 'https://example.invalid', enabled: true,
            color: '#2563EB', areaIds: ['dangling', 'area-a'] }]);
        expect(calendarSubscriptionSettingSource({}, ` ${raw}`)!.witness.fingerprint).not.toBe(first.witness.fingerprint);
        expect(calendarSubscriptionSettingSource({}, JSON.stringify([{ name: 'Missing ID', url: 'https://example.invalid' }]))).toBeNull();
        expect(calendarSubscriptionSettingSource({}, '{')).toBeNull();
        expect(calendarSubscriptionSettingSource({}, JSON.stringify([feed, feed]))).toBeNull();
    });

    it('preserves byte-distinct IDs, Auto removal, dangling Areas and no-op policy', () => {
        const source = calendarSubscriptionSettingSource({ externalCalendars: [{ ...feed, id: 'é' }, { ...feed, id: 'é' }] }, null)!;
        expect(source.feeds).toHaveLength(2);
        expect(planCalendarSubscriptionSetting(source.feeds,
            { type: 'feed', feedId: 'é', field: 'color', value: null, revision: 'stale' })!.feeds)
            .toEqual([{ ...feed, id: 'é', color: undefined }, { ...feed, id: 'é' }]);
        expect(Object.hasOwn(planCalendarSubscriptionSetting(source.feeds,
            { type: 'feed', feedId: 'é', field: 'color', value: null, revision: 'stale' })!.feeds[0], 'color')).toBe(false);
        expect(planCalendarSubscriptionSetting(source.feeds,
            { type: 'feed', feedId: 'é', field: 'enabled', value: true, revision: 'stale' })!.changed).toBe(false);
        expect(planCalendarSubscriptionSetting(source.feeds,
            { type: 'removeFeed', feedId: 'absent', revision: 'stale' })!.changed).toBe(false);
        expect(planCalendarSubscriptionSetting(source.feeds,
            { type: 'feed', feedId: 'é', field: 'areaIds', value: [], revision: 'stale' })!.feeds)
            .toEqual([{ ...feed, id: 'é', areaIds: [] }, { ...feed, id: 'é' }]);
        expect(planCalendarSubscriptionSetting(source.feeds,
            { type: 'feed', feedId: 'é', field: 'color', value: '#not-a-swatch', revision: 'stale' })).toBeNull();
    });

    it('accepts the complete source boundary and refuses max+1 without truncating raw URLs', () => {
        const row = { ...feed, url: 'https://example.invalid/' };
        const overhead = Buffer.byteLength(JSON.stringify(['calendarSubscriptionSetting:v1', true, [row], null]));
        const url = row.url + 'x'.repeat(CALENDAR_SUBSCRIPTION_SOURCE_BYTES - overhead);
        const exact = { externalCalendars: [{ ...row, url }] };
        expect(calendarSubscriptionSettingSource(exact, 'ignored')!.feeds[0].url).toBe(url);
        expect(calendarSubscriptionSettingSource({ externalCalendars: [{ ...row, url: url + 'x' }] }, null)).toBeNull();
        expect(calendarSubscriptionSettingSource({}, JSON.stringify([row]) + ' '.repeat(CALENDAR_SUBSCRIPTION_SOURCE_BYTES))).toBeNull();
    });

    it('binds raw field/stamp presence and rejects malformed or ambiguous stored identities', () => {
        const absent = calendarSubscriptionSettingSource({}, null)!;
        const wrongCanonicalShape = calendarSubscriptionSettingSource({ externalCalendars: null } as unknown as AppSettings, null)!;
        const empty = calendarSubscriptionSettingSource({ externalCalendars: [] }, null)!;
        expect(new Set([absent.witness.fingerprint, wrongCanonicalShape.witness.fingerprint, empty.witness.fingerprint]).size).toBe(3);
        expect(absent.witness).toMatchObject({ stampPresent: false, stamp: null });
        expect(calendarSubscriptionSettingSource({ externalCalendars: [], syncPreferencesUpdatedAt: { externalCalendars: 'invalid' } }, null)).toBeNull();
        for (const rows of [
            [feed, feed], [{ ...feed, id: '' }], [{ ...feed, id: '   ' }], [{ ...feed, id: 'x'.repeat(201) }],
            [{ ...feed, enabled: 'true' }], [{ ...feed, areaIds: ['valid', 1] }], [{ ...feed, url: '' }], [null],
        ]) {
            expect(calendarSubscriptionSettingSource({ externalCalendars: rows } as unknown as AppSettings, null)).toBeNull();
            expect(calendarSubscriptionSettingSource({}, JSON.stringify(rows))).toBeNull();
        }
    });
});
