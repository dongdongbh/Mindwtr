const fs = require('fs');
const path = require('path');
const { withAndroidManifest, withDangerousMod } = require('@expo/config-plugins');

function tryLoadPlugin() {
    const candidates = [
        'react-native-android-widget',
        'react-native-android-widget/app.plugin',
        'react-native-android-widget/app.plugin.js',
    ];

    for (const id of candidates) {
        try {
            const mod = require(id);
            return mod?.default ?? mod;
        } catch (error) {
            // ignore and try next candidate
        }
    }

    return null;
}

const WIDGET_RECEIVER_CLASS_SUFFIX = '.widget.TasksWidget';
const WIDGET_UPDATE_ACTION = 'android.appwidget.action.APPWIDGET_UPDATE';
const THEME_CHANGE_ACTIONS = [
    'android.intent.action.CONFIGURATION_CHANGED',
    'android.intent.action.UI_MODE_CHANGED',
];

const getTasksWidgetConfig = (props) => {
    const widgets = Array.isArray(props?.widgets) ? props.widgets : [];
    return widgets.find((widget) => widget?.name === 'TasksWidget') ?? {};
};

const setXmlAttribute = (xml, attributeName, value, insertAfterAttribute) => {
    const line = `    android:${attributeName}="${value}"`;
    const existing = new RegExp(`    android:${attributeName}="[^"]*"`);
    if (existing.test(xml)) {
        return xml.replace(existing, line);
    }

    const anchor = new RegExp(`(    android:${insertAfterAttribute}="[^"]*"\\n)`);
    if (anchor.test(xml)) {
        return xml.replace(anchor, `$1${line}\n`);
    }

    return xml.replace(
        '<appwidget-provider xmlns:android="http://schemas.android.com/apk/res/android"\n',
        `<appwidget-provider xmlns:android="http://schemas.android.com/apk/res/android"\n${line}\n`
    );
};

const addThemeBroadcastActionsToWidgetReceiver = (config) =>
    withAndroidManifest(config, (cfg) => {
        const manifest = cfg.modResults?.manifest;
        const application = manifest?.application?.[0];
        const receivers = Array.isArray(application?.receiver) ? application.receiver : [];

        receivers.forEach((receiver) => {
            const receiverName = receiver?.$?.['android:name'];
            if (typeof receiverName !== 'string' || !receiverName.endsWith(WIDGET_RECEIVER_CLASS_SUFFIX)) return;

            if (!Array.isArray(receiver['intent-filter'])) {
                receiver['intent-filter'] = [];
            }

            const filters = receiver['intent-filter'];
            const widgetFilter = filters.find((filter) => {
                const actions = Array.isArray(filter?.action) ? filter.action : [];
                return actions.some((entry) => entry?.$?.['android:name'] === WIDGET_UPDATE_ACTION);
            }) || filters[0];

            if (!widgetFilter) {
                filters.push({
                    action: [{ $: { 'android:name': WIDGET_UPDATE_ACTION } }],
                });
            }

            const targetFilter = widgetFilter || filters[filters.length - 1];
            if (!Array.isArray(targetFilter.action)) {
                targetFilter.action = [];
            }

            for (const actionName of THEME_CHANGE_ACTIONS) {
                const exists = targetFilter.action.some((entry) => entry?.$?.['android:name'] === actionName);
                if (!exists) {
                    targetFilter.action.push({ $: { 'android:name': actionName } });
                }
            }
        });

        return cfg;
    });

const patchTasksWidgetProviderXml = (config, props = {}) =>
    withDangerousMod(config, [
        'android',
        async (cfg) => {
            const widgetConfig = getTasksWidgetConfig(props);
            const xmlPath = path.join(
                cfg.modRequest.platformProjectRoot,
                'app',
                'src',
                'main',
                'res',
                'xml',
                'widgetprovider_taskswidget.xml'
            );

            if (!fs.existsSync(xmlPath)) return cfg;

            const minResizeWidth = widgetConfig.minResizeWidth ?? widgetConfig.minWidth ?? '120dp';
            const minResizeHeight = widgetConfig.minResizeHeight ?? widgetConfig.minHeight ?? '120dp';
            const current = fs.readFileSync(xmlPath, 'utf8');
            let next = setXmlAttribute(current, 'minResizeWidth', minResizeWidth, 'minHeight');
            next = setXmlAttribute(next, 'minResizeHeight', minResizeHeight, 'minResizeWidth');

            if (next !== current) {
                fs.writeFileSync(xmlPath, next);
            }

            return cfg;
        },
    ]);

const patchTasksWidgetProvider = (config, androidPackage) =>
    withDangerousMod(config, [
        'android',
        async (cfg) => {
            if (!androidPackage) return cfg;

            const javaPath = path.join(
                cfg.modRequest.platformProjectRoot,
                'app',
                'src',
                'main',
                'java',
                ...androidPackage.split('.'),
                'widget',
                'TasksWidget.java'
            );

            if (!fs.existsSync(javaPath)) return cfg;

            const current = fs.readFileSync(javaPath, 'utf8');
            if (
                current.includes('Intent.ACTION_CONFIGURATION_CHANGED')
                && current.includes('Intent.ACTION_UI_MODE_CHANGED')
                && current.includes('RNWidgetJsCommunication.requestWidgetUpdate')
            ) {
                return cfg;
            }

            const next = `package ${androidPackage}.widget;

import android.content.Context;
import android.content.Intent;

import com.reactnativeandroidwidget.RNWidgetJsCommunication;
import com.reactnativeandroidwidget.RNWidgetProvider;

public class TasksWidget extends RNWidgetProvider {
    @Override
    public void onReceive(final Context context, final Intent intent) {
        if (intent != null) {
            final String action = intent.getAction();
            if (Intent.ACTION_CONFIGURATION_CHANGED.equals(action) || Intent.ACTION_UI_MODE_CHANGED.equals(action)) {
                RNWidgetJsCommunication.requestWidgetUpdate(context, getClass().getSimpleName());
            }
        }

        super.onReceive(context, intent);
    }
}
`;
            fs.writeFileSync(javaPath, next);
            return cfg;
        },
    ]);

module.exports = function withAndroidWidget(config, props = {}) {
    const plugin = tryLoadPlugin();
    const androidPackage = config?.android?.package;
    let nextConfig = config;

    if (typeof plugin === 'function') {
        nextConfig = plugin(config, props);
    }

    nextConfig = addThemeBroadcastActionsToWidgetReceiver(nextConfig);
    nextConfig = patchTasksWidgetProviderXml(nextConfig, props);
    nextConfig = patchTasksWidgetProvider(nextConfig, androidPackage);
    return nextConfig;
};
