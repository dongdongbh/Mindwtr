import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dismissCleartextSyncWarning, getCleartextSyncDestination, isCleartextSyncDismissed } from './cleartext-sync-warning';

describe('cleartext sync acknowledgment', () => {
    beforeEach(() => window.localStorage.clear());
    afterEach(() => vi.restoreAllMocks());

    it('normalizes WebDAV host, default port, trailing slash and data filename', () => {
        const destination = getCleartextSyncDestination('webdav', ' HTTP://SYNC.EXAMPLE.COM:80/dav/ ');
        expect(destination).toBe(getCleartextSyncDestination('webdav', 'http://sync.example.com/dav/data.json'));
        expect(destination).not.toBe(getCleartextSyncDestination('webdav', 'http://sync.example.com/DAV'));
        expect(destination).not.toBe(getCleartextSyncDestination('webdav', 'http://sync.example.com/other'));
    });

    it('normalizes self-hosted API roots and scopes acknowledgment by backend and destination', () => {
        const destination = getCleartextSyncDestination('cloud', 'http://sync.example.com/');
        expect(destination).toBe(getCleartextSyncDestination('cloud', 'http://sync.example.com/v1/data'));
        expect(destination).not.toBe(getCleartextSyncDestination('webdav', 'http://sync.example.com/v1/data'));
        expect(destination).not.toBe(getCleartextSyncDestination('cloud', 'http://other.example.com/'));
        expect(getCleartextSyncDestination('webdav', 'http://sync.example.com/dav?folder=a'))
            .not.toBe(getCleartextSyncDestination('webdav', 'http://sync.example.com/dav?folder=b'));
    });

    it.each(['http://localhost/dav', 'http://127.0.0.1/dav', 'http://[::1]/dav', 'https://sync.example.com/dav', 'invalid'])('exempts %s', (url) => {
        expect(getCleartextSyncDestination('webdav', url)).toBeNull();
    });

    it('persists only a fingerprint, without URL credentials, query values or fragments', () => {
        const destination = getCleartextSyncDestination('webdav', 'http://alice:secret@sync.example.com/dav?token=private#fragment')!;
        expect(destination).toMatch(/^mindwtr:cleartextSyncDismissed:webdav:[a-f0-9]{32}$/);
        expect(destination).toBe(getCleartextSyncDestination('webdav', 'http://bob:different@sync.example.com/dav?token=private'));
        expect(isCleartextSyncDismissed(destination)).toBe(false);
        const write = vi.spyOn(window.localStorage, 'setItem');
        dismissCleartextSyncWarning(destination);
        expect(isCleartextSyncDismissed(destination)).toBe(true);
        expect(write).toHaveBeenCalledExactlyOnceWith(destination, 'true');
        expect(window.localStorage.getItem(destination)).toBe('true');
    });

    it('treats storage failure as nonfatal', () => {
        vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => { throw new Error('unavailable'); });
        vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => { throw new Error('unavailable'); });
        expect(isCleartextSyncDismissed('destination')).toBe(false);
        expect(() => dismissCleartextSyncWarning('destination')).not.toThrow();
    });
});
