import { describe, expect, it } from 'vitest';
const { setGmailMetadata } = require('./android-gmail-authorization').__testables;

describe('Android Gmail build metadata', () => {
  it('replaces stale or duplicate gates and preserves unrelated metadata', () => {
    const manifest = { manifest: { application: [{ 'meta-data': [
      { $: { 'android:name': 'MindwtrGmailEnabled', 'android:value': 'true' } },
      { $: { 'android:name': 'other', 'android:value': 'retained' } },
      { $: { 'android:name': 'MindwtrGmailEnabled', 'android:value': 'true' } },
    ] }] } };
    setGmailMetadata(manifest, false);
    expect(manifest.manifest.application[0]['meta-data']).toEqual([
      { $: { 'android:name': 'other', 'android:value': 'retained' } },
      { $: { 'android:name': 'MindwtrGmailEnabled', 'android:value': 'false' } },
    ]);
    setGmailMetadata(manifest, true);
    expect(manifest.manifest.application[0]['meta-data'][1].$['android:value']).toBe('true');
    expect(manifest.manifest.application[0]['meta-data']).toHaveLength(2);
  });

  it('requires an explicit boolean opt-in', () => {
    const manifest = { manifest: { application: [{}] } };
    setGmailMetadata(manifest, 'true');
    expect(manifest.manifest.application[0]['meta-data'][0].$['android:value']).toBe('false');
  });
});
