// node --test apps/android-native/scripts/check-variant-identity.test.mjs (no Gradle needed)
// Each build type's identity as Gradle merges it, built here from the app manifest and RN's widget and shortcut builders, passes
// the identity check; each broken identity is caught.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { buildLinkSchemeXml, buildShortcuts, buildShortcutsManifest } from './build-shortcuts.mjs';
import { buildManifest as buildWidgetManifest } from './build-widgets.mjs';
import { identityProblems, launcherIconProblems } from './check-variant-identity.mjs';

const require = createRequire(import.meta.url);
const { Builder, parseStringPromise } = require('xml2js');
const app = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../mobile/app.json'), 'utf8')).expo;
const NAMESPACE = 'tech.dongdongbh.mindwtr.pilot';
const HEARTBEAT = 'https://mindwtr-analytics.mindwtr.workers.dev/';
const BENCH = { pkg: 'tech.dongdongbh.mindwtr.nativeclient.dev.benchmark', scheme: 'mindwtr-native-bench', label: 'Mindwtr', rn: false };
const TYPES = {
    debug: { pkg: 'tech.dongdongbh.mindwtr.nativeclient.dev', scheme: 'mindwtr-native-dev', label: 'Mindwtr Native Dev', rn: false },
    upgradetest: { pkg: 'tech.dongdongbh.mindwtr.upgradetest', scheme: 'mindwtr-upgradetest', label: 'Mindwtr Native Dev', rn: true },
    release: { pkg: app.android.package, scheme: 'mindwtr', label: app.name, rn: true },
    benchmark: BENCH, benchmarkSeed: BENCH, benchmarkTrace: BENCH,
};

/** One build type's three files as Gradle would write them: the merged manifest, the shortcuts XML and BuildConfig.java. */
async function variant(type, { pkg, scheme, label, rn } = TYPES[type]) {
    const main = readFileSync(resolve(import.meta.dirname, '../android/app/src/main/AndroidManifest.xml'), 'utf8')
        .replaceAll('${applicationId}', pkg).replaceAll('${urlScheme}', scheme).replaceAll('${appLabel}', label);
    const root = (await parseStringPromise(main)).manifest;
    const application = root.application[0];
    for (const overlay of [buildWidgetManifest(pkg, label), buildShortcutsManifest()]) {
        const extra = (await parseStringPromise(overlay)).manifest.application[0];
        for (const [kind, nodes] of Object.entries(extra)) if (kind !== '$') application[kind] = [...(application[kind] ?? []), ...nodes];
    }
    // The merger's work: the libraries' permissions (WorkManager's, biometric's, AndroidX core's), the package, the version, and
    // names relative to the namespace made whole.
    root['uses-permission'].push(...['android.permission.FOREGROUND_SERVICE', 'android.permission.WAKE_LOCK',
        'android.permission.USE_FINGERPRINT', `${pkg}.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`].map((name) => ({ $: { 'android:name': name } })));
    Object.assign(root.$, { package: pkg, 'android:versionCode': type === 'release' ? String(app.android.versionCode) : '1',
        'android:versionName': type === 'release' ? app.version : 'native-dev' });
    for (const nodes of Object.values(application)) {
        for (const node of Array.isArray(nodes) ? nodes : []) {
            for (const key of ['android:name', 'android:targetActivity']) if (node.$?.[key]?.startsWith('.')) node.$[key] = NAMESPACE + node.$[key];
        }
    }
    return {
        manifest: new Builder().buildObject({ manifest: root }),
        shortcuts: buildShortcuts(scheme, pkg).xml,
        linkScheme: buildLinkSchemeXml(scheme),
        buildConfig: `  public static final boolean RN_STORAGE = ${rn};\n  public static final String URL_SCHEME = "${scheme}";\n`
            + `  public static final String ANALYTICS_HEARTBEAT_URL = "${type === 'release' ? HEARTBEAT : ''}";\n`,
    };
}
// The checker reads the heartbeat environment (RN's rule); these files carry RN's default endpoint, so the tests run without
// either variable and put the caller's back afterwards.
const HEARTBEAT_ENV = ['ANALYTICS_HEARTBEAT_DISABLED', 'ANALYTICS_HEARTBEAT_URL'];
const savedEnv = Object.fromEntries(HEARTBEAT_ENV.map((name) => [name, process.env[name]]));
before(() => { for (const name of HEARTBEAT_ENV) delete process.env[name]; });
after(() => { for (const [name, value] of Object.entries(savedEnv)) if (value === undefined) delete process.env[name]; else process.env[name] = value; });
const problems = (type, files) => identityProblems(type, files.manifest, files.shortcuts, files.buildConfig, files.linkScheme);

test('every build type\'s identity passes', async () => {
    for (const type of Object.keys(TYPES)) assert.deepEqual([type, await problems(type, await variant(type))], [type, []]);
});

test('a debug or benchmark build with the production package or scheme is caught', async () => {
    const production = { ...TYPES.debug, pkg: app.android.package };
    assert.notDeepEqual(await problems('debug', await variant('debug', production)), []);
    assert.notDeepEqual(await problems('benchmarkSeed', await variant('benchmarkSeed', { ...BENCH, scheme: 'mindwtr' })), []);
    assert.notDeepEqual(await problems('debug', await variant('debug', { ...TYPES.debug, rn: true })), []);
});

test('a heartbeat outside a release is caught', async () => {
    for (const type of ['debug', 'upgradetest', 'benchmarkTrace']) {
        const files = await variant(type);
        files.buildConfig = files.buildConfig.replace('ANALYTICS_HEARTBEAT_URL = ""', `ANALYTICS_HEARTBEAT_URL = "${HEARTBEAT}"`);
        assert.notDeepEqual(await problems(type, files), [], type);
    }
});

test('a launcher alias with no activity behind it, or without the build\'s link scheme, is caught', async () => {
    const files = await variant('release');
    const broken = files.manifest.replace(`android:targetActivity="${NAMESPACE}.MainActivity"`, `android:targetActivity="${NAMESPACE}.Missing"`);
    assert.notEqual(broken, files.manifest);
    assert.notDeepEqual(await problems('release', { ...files, manifest: broken }), []);
    const root = (await parseStringPromise(files.manifest)).manifest;
    const view = root.application[0]['activity-alias'][0]['intent-filter'].find((filter) => filter.action[0].$['android:name'] === 'android.intent.action.VIEW');
    view.data[0].$['android:scheme'] = 'mindwtr-native-dev';
    assert.notDeepEqual(await problems('release', { ...files, manifest: new Builder().buildObject({ manifest: root }) }), []);
});

test('widget providers that are not exported, or lack their filter or provider XML, are caught', async () => {
    const files = await variant('release');
    const root = (await parseStringPromise(files.manifest)).manifest;
    const providers = root.application[0].receiver.filter((receiver) => receiver['meta-data']?.some((meta) => meta.$['android:name'] === 'android.appwidget.provider'));
    assert.equal(providers.length, 4);
    for (const breakIt of [(p) => { p.$['android:exported'] = 'false'; }, (p) => { delete p['intent-filter']; }, (p) => { delete p['meta-data']; }]) {
        const copy = structuredClone(root);
        breakIt(copy.application[0].receiver.find((receiver) => receiver.$['android:name'] === providers[0].$['android:name']));
        assert.notDeepEqual(await problems('release', { ...files, manifest: new Builder().buildObject({ manifest: copy }) }), []);
    }
});

test('a detailed capture link of RN\'s scheme in a build with its own is caught', async () => {
    for (const type of ['debug', 'upgradetest', 'benchmark']) {
        assert.notDeepEqual(await problems(type, { ...await variant(type), linkScheme: buildLinkSchemeXml('mindwtr') }), [], type);
    }
});

test('a permission RN declares and the build drops is caught', async () => {
    const files = await variant('release');
    const dropped = files.manifest.replace(/<uses-permission android:name="android\.permission\.RECORD_AUDIO"\/>/, '');
    assert.notEqual(dropped, files.manifest);
    assert.notDeepEqual(await problems('release', { ...files, manifest: dropped }), []);
});

// RN's df75a3584 and a13d1184e: a FOSS build (BuildConfig.FOSS) declares no Google Play services component or metadata and no
// install referrer permission; the Play build keeps the referrer (PlayServices.kt reads it).
test('a FOSS build with the install referrer permission or a Google Play services entry is caught', async () => {
    const play = await variant('release');
    const foss = { ...play, buildConfig: `${play.buildConfig}  public static final boolean FOSS = true;\n` };
    assert.deepEqual(await problems('release', foss), []);
    const referrer = '<uses-permission android:name="com.google.android.finsky.permission.BIND_GET_INSTALL_REFERRER_SERVICE"/>';
    const withReferrer = (files) => ({ ...files, manifest: files.manifest.replace('<application', `${referrer}<application`) });
    assert.deepEqual(await problems('release', withReferrer(play)), []);
    assert.notDeepEqual(await problems('release', withReferrer(foss)), []);
    for (const entry of ['<service android:name="com.google.android.gms.metadata.ModuleDependencies" android:exported="false"/>',
        '<meta-data android:name="com.google.android.gms.version" android:value="12451000"/>',
        '<activity android:name="com.google.android.play.core.common.PlayCoreDialogWrapperActivity"/>',
        '<provider android:name="com.google.firebase.provider.FirebaseInitProvider" android:authorities="x"/>']) {
        const manifest = foss.manifest.replace('</application>', `${entry}</application>`);
        assert.notDeepEqual(await problems('release', { ...foss, manifest }), [], entry);
    }
});

// RN's 55049a2e0: Android 13's themed icons draw the adaptive icon's monochrome layer. Every variant launches from
// @mipmap/ic_launcher and ic_launcher_round, and each adaptive icon keeps a monochrome layer whose drawable exists.
test('a launcher icon without its monochrome layer, or a variant that points elsewhere, is caught', async () => {
    const res = resolve(import.meta.dirname, '../android/app/src');
    assert.deepEqual(launcherIconProblems(res), []);
    const files = await variant('release');
    assert.notDeepEqual(await problems('release', { ...files, manifest: files.manifest.replace('android:icon="@mipmap/ic_launcher"', 'android:icon="@mipmap/other"') }), []);
    const { mkdtempSync, mkdirSync, writeFileSync, cpSync } = await import('node:fs');
    mkdirSync(resolve(import.meta.dirname, '../android/build'), { recursive: true });
    const copy = mkdtempSync(resolve(import.meta.dirname, '../android/build/icon-test-'));
    try {
        cpSync(resolve(res, 'main/res/mipmap-anydpi-v26'), resolve(copy, 'main/res/mipmap-anydpi-v26'), { recursive: true });
        mkdirSync(resolve(copy, 'main/res/drawable'), { recursive: true });
        writeFileSync(resolve(copy, 'main/res/drawable/ic_launcher_monochrome.xml'), '<vector/>');
        assert.deepEqual(launcherIconProblems(copy), []);
        const round = resolve(copy, 'main/res/mipmap-anydpi-v26/ic_launcher_round.xml');
        writeFileSync(round, readFileSync(round, 'utf8').replace(/\s*<monochrome [^>]*\/>/, ''));
        assert.notDeepEqual(launcherIconProblems(copy), []);
        // A flavor or build type's own icon must keep the layer too.
        mkdirSync(resolve(copy, 'foss/res/mipmap-anydpi-v26'), { recursive: true });
        writeFileSync(resolve(copy, 'foss/res/mipmap-anydpi-v26/ic_launcher.xml'), '<adaptive-icon><foreground android:drawable="@mipmap/x"/></adaptive-icon>');
        assert.ok(launcherIconProblems(copy).some((problem) => problem.includes('foss')));
    } finally {
        const { rmSync } = await import('node:fs');
        rmSync(copy, { recursive: true, force: true });
    }
});

test('narrower share filters, or the debug build\'s check entries in another build, are caught', async () => {
    const files = await variant('release');
    const root = (await parseStringPromise(files.manifest)).manifest;
    const alias = root.application[0]['activity-alias'][0];
    alias['intent-filter'] = alias['intent-filter'].filter((filter) => filter.action[0].$['android:name'] !== 'android.intent.action.SEND_MULTIPLE');
    assert.notDeepEqual(await problems('release', { ...files, manifest: new Builder().buildObject({ manifest: root }) }), []);
    for (const type of ['release', 'upgradetest', 'benchmark', 'benchmarkTrace']) {
        const leaked = await variant(type);
        const leakedRoot = (await parseStringPromise(leaked.manifest)).manifest;
        leakedRoot.application[0].provider.push({ $: { 'android:name': 'tech.dongdongbh.mindwtr.pilot.ShareTestProvider', 'android:exported': 'true' } });
        assert.notDeepEqual(await problems(type, { ...leaked, manifest: new Builder().buildObject({ manifest: leakedRoot }) }), [], type);
        const sender = (await parseStringPromise(leaked.manifest)).manifest;
        sender.application[0].activity.push({ $: { 'android:name': 'tech.dongdongbh.mindwtr.pilot.ShareTestSender', 'android:exported': 'true' } });
        assert.notDeepEqual(await problems(type, { ...leaked, manifest: new Builder().buildObject({ manifest: sender }) }), [], `${type} sender`);
    }
});

test('missing or changed shortcuts are caught', async () => {
    const files = await variant('release');
    assert.notDeepEqual(await problems('release', { ...files, shortcuts: '<shortcuts xmlns:android="http://schemas.android.com/apk/res/android"/>' }), []);
    assert.notDeepEqual(await problems('release', { ...files, shortcuts: files.shortcuts.replace('android:shortcutId="focus"', 'android:shortcutId="today"') }), []);
});
