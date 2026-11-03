import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const plugin = require('./patch-expo-document-picker');

const { APPLIED_MARKER, applyPersistableGrant, getModuleCandidates, patchModuleSource } = plugin.__testables;


const vendoredModulePath = [process.cwd(), path.join(process.cwd(), 'apps', 'mobile')]
  .flatMap((root) => getModuleCandidates(root))
  .find((candidate) => fs.existsSync(candidate));


const PRISTINE_SOURCE = `class DocumentPickerModule : Module() {
  private fun readDocumentDetails(uri: Uri): DocumentInfo {
    val originalDocumentDetails = DocumentDetailsReader(context).read(uri)

    val details = if (!copyToCacheDirectory) {
      originalDocumentDetails
    } else {
      val copyPath = copyDocumentToCacheDirectory(uri, originalDocumentDetails.name)
      originalDocumentDetails.copy(uri = copyPath)
    }

    return details
  }
}
`;

const tempRoots = [];
const makeProjectRoot = (source) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'docpicker-patch-'));
  tempRoots.push(root);
  const target = getModuleCandidates(root)[0];
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, source);
  return { root, target };
};

afterEach(() => {
  while (tempRoots.length) fs.rmSync(tempRoots.pop(), { force: true, recursive: true });
});

describe('patch-expo-document-picker plugin', () => {
  it('takes a persistable read grant for a document it does not copy, so a picked .ics still reads after a reboot', () => {
    const patched = applyPersistableGrant(PRISTINE_SOURCE);

    expect(patched).toContain(APPLIED_MARKER);
    expect(patched).toContain('context.contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)');

    const grant = patched.indexOf('takePersistableUriPermission');
    expect(grant).toBeGreaterThan(patched.indexOf('val details = if (!copyToCacheDirectory) {'));
    expect(grant).toBeLessThan(patched.indexOf('    } else {'));

    expect(patched).toContain('catch (_: SecurityException)');
  });

  it('is idempotent', () => {
    const once = applyPersistableGrant(PRISTINE_SOURCE);
    expect(applyPersistableGrant(once)).toBe(once);
  });

  it('still finds its anchor in the vendored expo-document-picker source', () => {
    expect(vendoredModulePath).toBeTruthy();
    expect(applyPersistableGrant(fs.readFileSync(vendoredModulePath, 'utf8'))).toContain(APPLIED_MARKER);
  });

  it('writes the edit through patchModuleSource once, and throws when the anchor is gone', () => {
    const { root, target } = makeProjectRoot(PRISTINE_SOURCE);
    expect(patchModuleSource(root)).toBe(true);
    const afterFirst = fs.readFileSync(target, 'utf8');
    expect(afterFirst).toContain(APPLIED_MARKER);
    expect(patchModuleSource(root)).toBe(true);
    expect(fs.readFileSync(target, 'utf8')).toBe(afterFirst);

    const { root: moved } = makeProjectRoot('class DocumentPickerModule : Module() {\n}\n');
    expect(() => patchModuleSource(moved)).toThrow(/did not apply/);
  });

  it('is wired in: app.json runs it and the module builds from source (expo-* ship a prebuilt AAR)', () => {
    const mobile = __dirname;
    const appJson = JSON.parse(fs.readFileSync(path.join(mobile, '..', 'app.json'), 'utf8'));
    expect(appJson.expo.plugins).toContain('./plugins/patch-expo-document-picker');
    const pkg = JSON.parse(fs.readFileSync(path.join(mobile, '..', 'package.json'), 'utf8'));
    expect(pkg.expo.autolinking.android.buildFromSource).toContain('expo-document-picker');
  });
});
