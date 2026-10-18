// RN's app shortcuts for the native app, one resource set per build type: the XML and strings of
// apps/mobile/plugins/android-app-shortcuts.js (its own builder, so the ids, capabilities, labels and Add task's target, RN's quick
// capture dialog QuickCaptureActivity in the build's package, stay RN's), with one change: RN's mindwtr:/// links use the build's
// scheme (the development build's mindwtr-native-dev, so RN's app on the same phone keeps mindwtr://). Each build type also gets
// the manifest entry RN's plugin adds for a shortcut's own target, its detailed capture activity (#1333), as one more manifest, and
// the build's scheme as RN's widget module's mindwtr_link_scheme, so the links its appIntent opens (that activity's, the widgets'
// header and row links) are ones this build opens.
// Usage: node build-shortcuts.mjs <out dir> <build type>=<scheme>@<applicationId> ...
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { __testables: rn } = require('../../mobile/plugins/android-app-shortcuts.js');
const { Builder } = require('xml2js');

export function buildShortcuts(scheme, applicationId) {
    if (!/^[a-z][a-z0-9+.-]*$/.test(scheme)) throw new Error(`invalid scheme ${scheme}`);
    if (!/^[a-zA-Z][\w]*(\.[a-zA-Z][\w]*)+$/.test(applicationId)) throw new Error(`invalid applicationId ${applicationId}`);
    const source = rn.buildShortcutsXml(applicationId);
    const links = source.match(/mindwtr:\/\/\//g)?.length ?? 0;
    const xml = source.replaceAll('mindwtr:///', `${scheme}:///`);
    if ((xml.match(new RegExp(`${scheme.replace(/[.+]/g, '\\$&')}:///`, 'g'))?.length ?? 0) !== links) {
        throw new Error('shortcut links were not all moved to the build\'s scheme');
    }
    return { xml, strings: rn.SHORTCUTS_STRINGS_XML };
}

/** The activities RN's plugin adds beside its MainActivity (ensureManifestAppActions), as a variant's extra manifest. */
export function buildShortcutsManifest() {
    const main = { $: { 'android:name': '.MainActivity' } };
    const manifest = { manifest: { $: { 'xmlns:android': 'http://schemas.android.com/apk/res/android' }, application: [{ activity: [main] }] } };
    rn.ensureManifestAppActions(manifest);
    const application = manifest.manifest.application[0];
    application.activity = application.activity.filter((activity) => activity !== main);
    if (application.activity.length === 0) throw new Error('RN\'s shortcuts plugin no longer adds a target activity');
    return new Builder({ renderOpts: { pretty: true, indent: '    ' }, xmldec: { version: '1.0', encoding: 'utf-8' } }).buildObject(manifest);
}

/** The build's [scheme] as the widget module's mindwtr_link_scheme (an app resource overrides the module's RN default). */
export const buildLinkSchemeXml = (scheme) => `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <string name="mindwtr_link_scheme" translatable="false">${scheme}</string>
</resources>
`;

const [out, ...variants] = process.argv.slice(2);
if (import.meta.url === pathToFileURL(process.argv[1]).href && (!out || variants.length === 0)) {
    throw new Error('usage: build-shortcuts.mjs <out dir> <build type>=<scheme>@<applicationId> ...');
}
const fail = (variant) => { throw new Error(`invalid variant ${variant}`); };
for (const variant of import.meta.url === pathToFileURL(process.argv[1]).href ? variants : []) {
    const [, type, scheme, applicationId] = /^([^=]+)=([^@]+)@(.+)$/.exec(variant) ?? fail(variant);
    const { xml, strings } = buildShortcuts(scheme, applicationId);
    const res = resolve(out, type, 'res');
    mkdirSync(resolve(res, 'xml'), { recursive: true });
    mkdirSync(resolve(res, 'values'), { recursive: true });
    writeFileSync(resolve(res, 'xml', 'mindwtr_shortcuts.xml'), xml);
    writeFileSync(resolve(res, 'values', 'mindwtr_shortcuts_strings.xml'), strings);
    writeFileSync(resolve(out, type, 'AndroidManifest.xml'), buildShortcutsManifest());
    writeFileSync(resolve(res, 'values', 'mindwtr_link_scheme.xml'), buildLinkSchemeXml(scheme));
}
