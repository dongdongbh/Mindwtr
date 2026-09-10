import { pathToFileURL } from 'node:url';

// Keep the fourth component zero: Microsoft reserves it for Store use.
// Each patch has 98 RC slots followed by its stable package at slot 99.
export function msstoreVersion(tag) {
  const match = /^v?([1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-rc\.([1-9]\d*))?$/.exec(tag);
  if (!match) throw new Error('Expected a stable version or vX.Y.Z-rc.N.');
  const [, major, minor, patch, rc] = match;
  if (rc && Number(rc) > 98) throw new Error('Microsoft Store RC numbers must be between 1 and 98.');
  const parts = [Number(major), Number(minor), Number(patch) * 100 + (rc ? Number(rc) : 99), 0];
  if (parts.some(part => !Number.isSafeInteger(part) || part > 65535)) {
    throw new Error('Microsoft Store version component exceeds 65535.');
  }
  return parts.join('.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(msstoreVersion(process.argv[2] || ''));
}
