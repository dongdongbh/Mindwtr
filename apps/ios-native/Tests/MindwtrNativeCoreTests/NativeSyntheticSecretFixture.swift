import Foundation

/// The existing macOS WebDAV fixture's bounded durable synthetic secret port.
/// No platform Security query, production namespace, or ordinary bundle change.
enum NativeSyntheticSecretFixture {
    static let cacheFileName = "foreground-fixture-secrets.json"
    #if os(macOS)
    static func makeBundle(source: URL, directory: URL) throws -> URL {
        let suffix = """
        ;(() => {
            const file = globalThis.__mindwtrFileCall;
            if (typeof file !== 'function') throw new Error('Synthetic credential fixture unavailable');
            const directories = JSON.parse(globalThis.__mindwtrNative.fileDirectories());
            const uri = directories.cache.replace(/\\/$/, '') + '/foreground-fixture-secrets.json';
            const accounts = ['mindwtr_webdav_password', 'mindwtr_cloud_token', 'mindwtr_sync_encryption_key_v1'];
            const maximumBytes = 16 * 1024;
            const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true });
            const owns = (record, account) => Object.prototype.hasOwnProperty.call(record, account);
            const account = (name) => {
                if (typeof name !== 'string' || !accounts.includes(name)) throw new Error('Synthetic credential fixture unavailable');
            };
            const read = async () => {
                const info = await file({ op: 'getInfo', uri });
                if (!info || typeof info.exists !== 'boolean') throw new Error('Synthetic credential fixture unavailable');
                if (!info.exists) return Object.create(null);
                if (info.isDirectory !== false || !Number.isSafeInteger(info.size) || info.size < 0 || info.size > maximumBytes) {
                    throw new Error('Synthetic credential fixture unavailable');
                }
                const bytes = await file({ op: 'readBytes', uri });
                if (!(bytes instanceof Uint8Array) || bytes.byteLength > maximumBytes) throw new Error('Synthetic credential fixture unavailable');
                const record = JSON.parse(decoder.decode(bytes));
                if (!record || Array.isArray(record) || typeof record !== 'object'
                    || Object.keys(record).some((name) => !accounts.includes(name) || typeof record[name] !== 'string'
                        || encoder.encode(record[name]).byteLength > 4096)) throw new Error('Synthetic credential fixture unavailable');
                return record;
            };
            const write = async (record) => {
                const bytes = encoder.encode(JSON.stringify(record));
                if (bytes.byteLength > maximumBytes) throw new Error('Synthetic credential fixture unavailable');
                await file({ op: 'writeBytes', uri }, bytes);
            };
            let pending = Promise.resolve();
            const serial = (work) => {
                const next = pending.then(work);
                pending = next.catch(() => {});
                return next;
            };
            globalThis.__mindwtrSyncSecrets = {
                getSecret: (name) => serial(async () => {
                    account(name);
                    const record = await read();
                    return owns(record, name) ? record[name] : null;
                }),
                setSecret: (name, value) => serial(async () => {
                    account(name);
                    if (typeof value !== 'string' || encoder.encode(value).byteLength > 4096) throw new Error('Synthetic credential fixture unavailable');
                    const record = await read();
                    record[name] = value;
                    await write(record);
                }),
                deleteSecret: (name) => serial(async () => {
                    account(name);
                    const record = await read();
                    if (owns(record, name)) { delete record[name]; await write(record); }
                }),
            };
        })();
        """
        let fixtureBundle = directory.appendingPathComponent("foreground-fixture-core-host.js")
        try (String(contentsOf: source, encoding: .utf8) + "\n" + suffix).write(to: fixtureBundle, atomically: true, encoding: .utf8)
        return fixtureBundle
    }
    #endif
}
