// One native Android variant's identity (plan pass O3), as its merged manifest and its app shortcuts have it: the names that
// launchers, widget hosts, the Quick Settings panel and automations stored for RN's app (inventory section 6); for a release,
// RN's package, version, number and name (apps/mobile/app.json), so it installs over RN's store app in place; and which storage
// its BuildConfig opens (RN's files in a release and the upgrade harness build, the dev database elsewhere); and RN's backup rules,
// which back up and transfer nothing; RN's microphone permission and right-to-left layout; and a declared component behind every
// shortcut target; and the heartbeat endpoint, RN's (app.config.ts's rule and default) in a release and none in any other build.
// Every build type has its own package and link scheme, so only a release can replace RN's app or answer RN's links. The launcher
// alias opens a declared activity, the widget providers are exported with their filter and provider XML, and the shortcuts are
// RN's (build-shortcuts.mjs's output for the build), with the build's scheme as RN's widget module's mindwtr_link_scheme. The
// permissions are RN's, so an upgrade keeps every grant. The alias takes RN's shares (app.json's expo-share-intent filters). The
// debug build's check entries (its widget host, quick capture alias, and file share provider and sender) are in no other build. A
// FOSS build (BuildConfig.FOSS) declares no Google Play services entry and no install referrer permission, as RN's FOSS build
// strips them (df75a3584, a13d1184e); checkFossDependencies checks its libraries. Gradle's checkVariantIdentity runs it for each variant (app/build.gradle.kts);
// it prints every problem and fails on any; check-variant-identity.test.mjs proves what it catches.
// Usage: node check-variant-identity.mjs <build type> <merged AndroidManifest.xml> <mindwtr_shortcuts.xml> <BuildConfig.java>
//     <mindwtr_link_scheme.xml>
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildLinkSchemeXml, buildShortcuts } from './build-shortcuts.mjs';

const require = createRequire(import.meta.url);
const { parseStringPromise } = require('xml2js');
const app = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../mobile/app.json'), 'utf8')).expo;
const rnManifest = require('../../mobile/plugins/android-manifest-fixes.js').__testables;
/** RN's heartbeat endpoint for this environment (app.config.ts): none when disabled, else ANALYTICS_HEARTBEAT_URL or its default. */
const rnHeartbeatUrl = () => {
    if (['1', 'true'].includes(process.env.ANALYTICS_HEARTBEAT_DISABLED)) return '';
    const config = readFileSync(resolve(import.meta.dirname, '../../mobile/app.config.ts'), 'utf8');
    const fallback = /const DEFAULT_ANALYTICS_HEARTBEAT_URL = '([^']+)';/.exec(config)?.[1];
    if (!fallback) throw new Error('app.config.ts no longer names DEFAULT_ANALYTICS_HEARTBEAT_URL');
    return (process.env.ANALYTICS_HEARTBEAT_URL ?? '').trim() || fallback;
};
const resXml = (name) => readFileSync(resolve(import.meta.dirname, `../android/app/src/main/res/xml/${name}.xml`), 'utf8');

// Each build type's package and link scheme (app/build.gradle.kts's packages and urlSchemes; upgradetest's and release's ids are set
// in its androidComponents).
const BENCHMARK = { pkg: 'tech.dongdongbh.mindwtr.nativeclient.dev.benchmark', scheme: 'mindwtr-native-bench' };
const IDENTITIES = {
    debug: { pkg: 'tech.dongdongbh.mindwtr.nativeclient.dev', scheme: 'mindwtr-native-dev' },
    upgradetest: { pkg: 'tech.dongdongbh.mindwtr.upgradetest', scheme: 'mindwtr-upgradetest' },
    release: { pkg: app.android.package, scheme: 'mindwtr' },
    benchmark: BENCHMARK, benchmarkSeed: BENCHMARK, benchmarkTrace: BENCHMARK,
};
// The v1.3.6 RN APK's permissions (Play and FOSS alike), but its package's own DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION. Play's
// install referrer permission is the one addition the native Play build keeps: PlayServices.kt reads the referrer.
const RN_PERMISSIONS = ['ACCESS_NETWORK_STATE', 'ACCESS_WIFI_STATE', 'FOREGROUND_SERVICE', 'INTERNET', 'MODIFY_AUDIO_SETTINGS',
    'POST_NOTIFICATIONS', 'READ_CALENDAR', 'RECEIVE_BOOT_COMPLETED', 'RECORD_AUDIO', 'SCHEDULE_EXACT_ALARM', 'USE_BIOMETRIC',
    'USE_FINGERPRINT', 'VIBRATE', 'WAKE_LOCK', 'WRITE_CALENDAR'].map((name) => `android.permission.${name}`);
const PLAY_REFERRER = 'com.google.android.finsky.permission.BIND_GET_INSTALL_REFERRER_SERVICE';
/** What RN's FOSS build strips (df75a3584, a13d1184e; scripts/verify_foss_no_google_services.py's packages): no component or
 *  metadata of these in a FOSS build's manifest. An intent action's name (Assistant's CREATE_NOTE) is no component. */
const GOOGLE_SERVICE_PREFIXES = ['com.google.android.gms.', 'com.google.firebase.', 'com.google.mlkit.', 'com.google.android.play.',
    'com.google.android.datatransport.', 'com.google.android.ump.', 'com.android.billingclient.', 'com.android.installreferrer.'];
const SHARE_CONFIG = app.plugins.find((plugin) => Array.isArray(plugin) && plugin[0] === 'expo-share-intent')[1];
/** The debug build's exported check entries (src/debug): never in a build a user installs. */
const DEBUG_ONLY = ['tech.dongdongbh.mindwtr.pilot.WidgetHostActivity', 'tech.dongdongbh.mindwtr.pilot.ShareTestProvider',
    'tech.dongdongbh.mindwtr.pilot.ShareTestSender'];
const WIDGET_PROVIDERS = ['TasksWidgetProvider', 'CompactWidgetProvider', 'QuickCaptureWidgetProvider'].map((name) => `tech.dongdongbh.mindwtr.androidwidget.${name}`);

const attr = (node, name) => node?.$?.[`android:${name}`];
const named = (nodes, name) => (nodes ?? []).find((node) => attr(node, 'name') === name);

/** A BuildConfig.java field's value as its source spells it ("true", or a string literal's text). */
const field = (buildConfig, name) => {
    const match = new RegExp(`\\b${name} = ("(?:[^"\\\\]|\\\\.)*"|\\w+);`).exec(buildConfig);
    return match ? (match[1].startsWith('"') ? JSON.parse(match[1]) : match[1]) : undefined;
};

/** Every problem with one variant's identity: [type] its build type; the rest, its files' text. */
export async function identityProblems(type, manifest, shortcuts, buildConfig, linkScheme) {
    const problems = [];
    const expect = (what, actual, wanted) => { if (actual !== wanted) problems.push(`${what} is ${actual}, not ${wanted}`); };
    const root = (await parseStringPromise(manifest)).manifest;
    const application = root.application[0];
    const pkg = root.$.package;
    const identity = IDENTITIES[type];
    if (!identity) return [`unknown build type ${type}`];
    expect('the package', pkg, identity.pkg);
    expect('URL_SCHEME', field(buildConfig, 'URL_SCHEME'), identity.scheme);
    if (type === 'release') {
        expect('the versionCode', attr(root, 'versionCode'), String(app.android.versionCode));
        expect('the versionName', attr(root, 'versionName'), app.version);
        expect('the app label', attr(application, 'label'), app.name);
    }
    // RN's "back up nothing" rules (android-manifest-fixes.js), the same files.
    expect('allowBackup', attr(application, 'allowBackup'), 'true');
    expect('fullBackupContent', attr(application, 'fullBackupContent'), '@xml/mindwtr_backup_rules');
    expect('dataExtractionRules', attr(application, 'dataExtractionRules'), '@xml/mindwtr_data_extraction_rules');
    if (resXml('mindwtr_backup_rules') !== rnManifest.BACKUP_RULES_XML) problems.push('the backup rules are not RN\'s');
    if (resXml('mindwtr_data_extraction_rules') !== rnManifest.DATA_EXTRACTION_RULES_XML) problems.push('the data extraction rules are not RN\'s');
    // The launcher's, pinned shortcuts' and widgets' component (WidgetRenderer.appIntent): RN's MainActivity name.
    const alias = named(application['activity-alias'], `${pkg}.MainActivity`);
    if (!alias) problems.push(`no ${pkg}.MainActivity`);
    else {
        expect('the MainActivity alias exported', attr(alias, 'exported'), 'true');
        if (!named(application.activity, attr(alias, 'targetActivity'))) problems.push(`the alias opens ${attr(alias, 'targetActivity')}, which is not declared`);
        const schemes = (alias['intent-filter'] ?? []).filter((filter) => named(filter.action, 'android.intent.action.VIEW'))
            .flatMap((filter) => (filter.data ?? []).map((data) => attr(data, 'scheme')));
        expect('the alias link schemes', JSON.stringify(schemes), JSON.stringify([identity.scheme]));
        // RN's share filters: SEND for text and files, SEND_MULTIPLE for files.
        const types = (action) => (alias['intent-filter'] ?? []).filter((filter) => named(filter.action, action))
            .flatMap((filter) => (filter.data ?? []).map((data) => attr(data, 'mimeType')));
        expect('the alias SEND types', JSON.stringify(types('android.intent.action.SEND')), JSON.stringify(SHARE_CONFIG.androidIntentFilters));
        expect('the alias SEND_MULTIPLE types', JSON.stringify(types('android.intent.action.SEND_MULTIPLE')), JSON.stringify(SHARE_CONFIG.androidMultiIntentFilters));
        if (type === 'release') expect('the MainActivity alias label', attr(alias, 'label'), app.name);
        if (!(alias['intent-filter'] ?? []).some((filter) => named(filter.action, 'android.intent.action.MAIN') && named(filter.category, 'android.intent.category.LAUNCHER'))) {
            problems.push(`${pkg}.MainActivity is not the launcher entry`);
        }
    }
    if (type !== 'debug') {
        const components = Object.values(application).flatMap((nodes) => (Array.isArray(nodes) ? nodes : [])).map((node) => attr(node, 'name'));
        for (const name of [...DEBUG_ONLY, `${pkg}.DebugQuickCapture`]) if (components.includes(name)) problems.push(`the debug build's ${name} is in this build`);
    }
    // A placed widget's provider: exported, updated by the widget host, with its provider XML.
    for (const name of [...WIDGET_PROVIDERS, `${pkg}.widget.TasksWidget`]) {
        const provider = named(application.receiver, name);
        if (!provider) { problems.push(`no widget provider ${name}`); continue; }
        expect(`${name} exported`, attr(provider, 'exported'), 'true');
        if (!(provider['intent-filter'] ?? []).some((filter) => named(filter.action, 'android.appwidget.action.APPWIDGET_UPDATE'))) problems.push(`${name} takes no widget updates`);
        if (!attr(named(provider['meta-data'], 'android.appwidget.provider'), 'resource')) problems.push(`${name} has no provider XML`);
    }
    for (const name of ['tech.dongdongbh.mindwtr.androidwidget.CaptureIntentReceiver', 'tech.dongdongbh.mindwtr.contextautomation.ContextAutomationReceiver']) {
        if (!named(application.receiver, name)) problems.push(`no receiver ${name}`);
    }
    if (!named(application.service, 'tech.dongdongbh.mindwtr.quicksettings.CaptureTileService')) problems.push('no Quick Settings tile service');
    expect('RN_STORAGE', field(buildConfig, 'RN_STORAGE'), String(type === 'release' || type === 'upgradetest'));
    expect('ANALYTICS_HEARTBEAT_URL', field(buildConfig, 'ANALYTICS_HEARTBEAT_URL'), type === 'release' ? rnHeartbeatUrl() : '');
    const permissions = (root['uses-permission'] ?? []).map((node) => attr(node, 'name'))
        .filter((name) => name !== `${pkg}.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION` && name !== PLAY_REFERRER).sort();
    expect('the permissions', JSON.stringify(permissions), JSON.stringify(RN_PERMISSIONS));
    if (field(buildConfig, 'FOSS') === 'true') {
        if ((root['uses-permission'] ?? []).some((node) => attr(node, 'name') === PLAY_REFERRER)) problems.push('a FOSS build declares the install referrer permission');
        const entries = ['activity', 'activity-alias', 'service', 'receiver', 'provider', 'meta-data']
            .flatMap((kind) => (application[kind] ?? []).map((node) => attr(node, 'name') ?? ''));
        for (const name of entries.filter((entry) => GOOGLE_SERVICE_PREFIXES.some((prefix) => entry.startsWith(prefix)))) {
            problems.push(`a FOSS build declares the Google service entry ${name}`);
        }
    }
    expect('supportsRtl', attr(application, 'supportsRtl'), 'true');
    // RN's shortcuts for this build (their ids, labels, targets and links), each target a component the build declares.
    if (shortcuts !== buildShortcuts(identity.scheme, identity.pkg).xml) problems.push('the shortcuts are not RN\'s for this build');
    // The widget module's links (WidgetRenderer.appIntent: the widgets' header and row links, the detailed capture shortcut's) are
    // of the build's own scheme, which core opens.
    if (linkScheme !== buildLinkSchemeXml(identity.scheme)) problems.push(`mindwtr_link_scheme is not ${identity.scheme}`);
    const components = [...(application.activity ?? []), ...(application['activity-alias'] ?? [])].map((node) => attr(node, 'name'));
    for (const [, target] of shortcuts.matchAll(/android:targetClass="([^"]*)"/g)) {
        if (!components.includes(target)) problems.push(`the shortcut target ${target} is not declared`);
    }
    return problems;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    const [type, ...paths] = process.argv.slice(2);
    if (paths.length !== 4) throw new Error('usage: check-variant-identity.mjs <build type> <merged manifest> <shortcuts xml> <BuildConfig.java> <link scheme xml>');
    const [manifestPath] = paths;
    const problems = await identityProblems(type, ...paths.map((path) => readFileSync(path, 'utf8')));
    for (const problem of problems) console.error(`${type}: ${problem}`);
    if (problems.length > 0) process.exit(1);
    console.log(`${type}: identity ok (${manifestPath})`);
}
