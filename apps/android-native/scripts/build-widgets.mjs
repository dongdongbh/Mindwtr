


import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const mobile = resolve(import.meta.dirname, '../../mobile');
const widget = require(resolve(mobile, 'plugins/android-widget.js')).__testables;
const tile = require(resolve(mobile, 'plugins/android-quick-settings-tile.js')).__testables;
const { buildWidgetPreviewXml } = require(resolve(mobile, 'plugins/android-widget-preview.js'));
const { compactWidgetLocales, compactWidgetValuesDirectory } = require(resolve(mobile, 'plugins/android-widget-locales.js'));
const { Builder } = require('xml2js');


export const TILE_PACKAGE = 'tech.dongdongbh.mindwtr';
const APP_R = 'tech.dongdongbh.mindwtr.pilot.R';


export function widgetProps(label) {
    const app = JSON.parse(readFileSync(resolve(mobile, 'app.json'), 'utf8')).expo;
    const entry = app.plugins.find((plugin) => Array.isArray(plugin) && plugin[0] === './plugins/android-widget');
    return { ...entry[1], label };
}


export function buildManifest(applicationId, label) {
    const manifest = { manifest: { $: { 'xmlns:android': 'http://schemas.android.com/apk/res/android' }, application: [{}] } };
    widget.ensureWidgetComponents(manifest, widgetProps(label), applicationId);
    tile.ensureCaptureTileService(manifest);
    const service = manifest.manifest.application[0].service.find((entry) => entry.$['android:name'] === '.quicksettings.CaptureTileService');
    service.$['android:name'] = `${TILE_PACKAGE}.quicksettings.CaptureTileService`;
    return new Builder({ renderOpts: { pretty: true, indent: '    ' }, xmldec: { version: '1.0', encoding: 'utf-8' } }).buildObject(manifest);
}


export function buildTileSource() {
    const source = tile.buildCaptureTileServiceSource(TILE_PACKAGE);
    const rnR = `import ${TILE_PACKAGE}.R\n`;
    if (source.split(rnR).length !== 2) throw new Error('RN\'s tile no longer imports its R as expected');
    return source.replace(rnR, `import ${APP_R}\n`);
}

const write = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };


export function writeWidgets(root, applicationId, label) {
    rmSync(root, { recursive: true, force: true });
    const res = resolve(root, 'res');
    write(resolve(root, 'AndroidManifest.xml'), buildManifest(applicationId, label));

    const props = widget.resolveProps(widgetProps(label));
    const kinds = widget.buildWidgetKinds(props);
    for (const kind of [...kinds, widget.buildLegacyTasksWidgetKind(props, applicationId)]) {
        write(resolve(res, 'xml', `${kind.infoResource}.xml`), widget.buildWidgetInfoXml(kind));
    }
    const nativeLayouts = resolve(mobile, 'modules/android-widget/android/src/main/res/layout');
    for (const kind of kinds) {
        write(resolve(res, 'layout', `${kind.layout}_preview.xml`), buildWidgetPreviewXml(kind, (name) => readFileSync(resolve(nativeLayouts, `${name}.xml`), 'utf8')));
    }
    write(resolve(res, 'values', 'mindwtr_widget_strings.xml'), widget.buildWidgetStringsXml(kinds));
    for (const locale of Object.keys(compactWidgetLocales)) {
        const values = locale === 'en' ? 'values' : compactWidgetValuesDirectory(locale);
        write(resolve(res, values, 'mindwtr_compact_widget_strings.xml'), widget.buildCompactWidgetStringsXml(props.label, locale));
    }
    write(resolve(res, 'values', 'mindwtr_widget_styles.xml'), widget.buildWidgetStylesXml());
    for (const kind of kinds) {
        mkdirSync(resolve(res, 'drawable'), { recursive: true });
        copyFileSync(resolve(mobile, kind.previewImage), resolve(res, 'drawable', `${kind.layout}_preview.png`));
    }
    write(resolve(root, 'java', ...applicationId.split('.'), 'widget', 'TasksWidget.java'), widget.buildLegacyTasksWidgetSource(applicationId));

    write(resolve(root, 'java', ...TILE_PACKAGE.split('.'), 'quicksettings', 'CaptureTileService.kt'), buildTileSource());
    write(resolve(res, 'values', 'mindwtr_quick_settings_tile_strings.xml'), tile.buildTileStringsXml());
    write(resolve(res, 'drawable', 'ic_quick_settings_capture.xml'), tile.buildTileIconXml());
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    const [out, ...variants] = process.argv.slice(2);
    if (!out || variants.length === 0) throw new Error('usage: build-widgets.mjs <out dir> <build type>=<applicationId>:<label> ...');
    for (const variant of variants) {
        const [, type, applicationId, label] = /^([^=]+)=([^:]+):(.+)$/.exec(variant) ?? [];
        if (!type) throw new Error(`invalid variant ${variant}`);
        writeWidgets(resolve(out, type), applicationId, label);
    }
}
