

import { randomUUID } from 'node:crypto';

const MAGIC = Buffer.from('MWENC1');


export const encryptionCard = (view) => view?.encryption ?? null;


export const remoteArtifacts = (dav, folder) => {
    const all = [...dav.state.files].filter(([path, file]) => path.startsWith(`${folder}/`) && !file.dir)
        .map(([path, file]) => ({ path, body: file.body, etag: file.etag, text: file.body.toString('utf8'), encrypted: file.body.subarray(0, 6).equals(MAGIC) }));
    return {
        all,
        encrypted: all.filter((file) => file.encrypted),
        plain: all.filter((file) => !file.encrypted),
        fingerprint: all.map((file) => `${file.path}=${file.etag}`).sort().join('\n'),
    };
};


export const runEncryption = async (device, flow, fields, options = {}) => {
    const action = (input) => device.sync('runSyncEncryptionAction', input);
    if (options.open !== false) await action({ action: { type: 'open', flow } });
    for (const [field, value] of Object.entries(fields)) await action({ action: { type: 'typed', field, value } });
    return action({ requestId: randomUUID(), action: { type: 'submit', flow } }).catch((error) => ({ error: error.message }));
};
