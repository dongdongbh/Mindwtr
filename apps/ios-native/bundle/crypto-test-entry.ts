// Built only with build-bundle.mjs --crypto-test; never the application resource.
import '../../android-native/bundle/host-entry';
import { createHostSyncCrypto } from '../../android-native/bundle/host-sync';
import {
    SyncCryptoAuthError, SyncCryptoUnsupportedError, deriveSyncKeyMaterial,
    encryptSyncArtifact, decryptSyncArtifact, inspectSyncArtifact,
} from '../../../packages/core/src/sync-crypto';
import primitiveVectors from '../../../packages/core/src/__fixtures__/sync-crypto/primitive-vectors.json';
import vectors from '../../../packages/core/src/__fixtures__/sync-crypto/vectors.json';

const host = globalThis as typeof globalThis & { __mindwtrCryptoCall?: Parameters<typeof createHostSyncCrypto>[0]; cryptoGate?: unknown };
host.cryptoGate = {
    prims: createHostSyncCrypto(host.__mindwtrCryptoCall), refusing: createHostSyncCrypto(undefined),
    SyncCryptoAuthError, SyncCryptoUnsupportedError, deriveSyncKeyMaterial,
    encryptSyncArtifact, decryptSyncArtifact, inspectSyncArtifact, primitiveVectors, vectors,
};
