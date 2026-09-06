import { describe, expect, it } from 'vitest';

import { serializeWebdavCapabilityProof } from './webdav-capability-proof';

describe('serializeWebdavCapabilityProof', () => {
    const config = {
        url: 'https://dav.example.com/mindwtr/',
        username: 'alice',
        allowInsecureHttp: false,
    };

    it('encodes a versioned, normalized, secret-free identity', () => {
        const proof = serializeWebdavCapabilityProof({ ...config, password: 'must-not-persist' } as never);

        expect(proof).toContain('"version":1');
        expect(proof).toContain('https://dav.example.com/mindwtr/data.json');
        expect(proof).toContain('alice');
        expect(proof).not.toContain('must-not-persist');
    });

    it('trims the username and treats a missing one as empty', () => {
        expect(serializeWebdavCapabilityProof({ ...config, username: '  alice  ' }))
            .toBe(serializeWebdavCapabilityProof(config));
        expect(JSON.parse(serializeWebdavCapabilityProof({ url: config.url })).username).toBe('');
    });

    it.each([
        ['endpoint', { ...config, url: 'https://other.example.com/mindwtr/' }],
        ['username', { ...config, username: 'bob' }],
        ['insecure transport policy', { ...config, allowInsecureHttp: true }],
    ])('changes the proof when the %s changes', (_label, changedConfig) => {
        expect(serializeWebdavCapabilityProof(changedConfig)).not.toBe(serializeWebdavCapabilityProof(config));
    });
});
