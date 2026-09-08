import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const directory = process.argv[2];
if (!directory) throw new Error('Expected output directory');
const env = process.env;
const info = env.PACKAGE_INFO ?? '';
writeFileSync(join(directory, 'metadata.json'), `${JSON.stringify({
  platform: 'android', runtime: 'native', device: env.DEVICE_LABEL,
  deviceModel: env.DEVICE_MODEL, os: env.DEVICE_OS, buildType: 'release',
  dataset: env.DATASET_ID, network: env.NETWORK, scenario: env.BENCH_MODE,
  package: env.BENCH_PACKAGE, version: info.match(/versionName=([^\s]+)/)?.[1] ?? 'unknown',
  versionCode: info.match(/versionCode=(\d+)/)?.[1] ?? 'unknown',
  revision: env.BUILD_REVISION ?? 'unknown', capturedAt: new Date().toISOString(),
  artifactHash: createHash('sha256').update(env.APK_HASHES ?? '').digest('hex'),
}, null, 2)}\n`);
