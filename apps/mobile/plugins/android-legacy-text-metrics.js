const {
  AndroidConfig,
  createRunOncePlugin,
  withAndroidStyles,
} = require('@expo/config-plugins');

const APP_THEME = AndroidConfig.Styles.getAppThemeGroup();
const TEXT_VIEW_STYLE = { name: 'Mindwtr.TextView', parent: 'Widget.AppCompat.TextView' };
const EDIT_TEXT_STYLE = { name: 'Mindwtr.EditText', parent: 'Widget.AppCompat.EditText' };


const LEGACY_TEXT_ITEMS = [
  ['android:elegantTextHeight', 'false'],
  ['android:useLocalePreferredLineHeightForMinimum', 'false', '35'],
  ['android:useBoundsForWidth', 'false', '35'],
  ['android:shiftDrawingOffsetForStartOverhang', 'false', '35'],
];

const setStyleItem = (xml, parent, name, value, targetApi) =>
  AndroidConfig.Styles.assignStylesValue(xml, {
    add: true,
    parent,
    name,
    value,
    targetApi,
  });

const setLegacyTextMetrics = (xml) => {
  let next = xml;
  for (const [name, value, targetApi] of LEGACY_TEXT_ITEMS) {
    next = setStyleItem(next, TEXT_VIEW_STYLE, name, value, targetApi);
    next = setStyleItem(next, EDIT_TEXT_STYLE, name, value, targetApi);
  }
  next = setStyleItem(next, APP_THEME, 'android:textViewStyle', `@style/${TEXT_VIEW_STYLE.name}`);
  next = setStyleItem(next, APP_THEME, 'android:editTextStyle', `@style/${EDIT_TEXT_STYLE.name}`);
  next = setStyleItem(next, APP_THEME, 'editTextStyle', `@style/${EDIT_TEXT_STYLE.name}`);
  return next;
};

const withAndroidLegacyTextMetrics = (config) =>
  withAndroidStyles(config, (cfg) => {
    cfg.modResults = setLegacyTextMetrics(cfg.modResults);
    return cfg;
  });

module.exports = createRunOncePlugin(
  withAndroidLegacyTextMetrics,
  'mindwtr-android-legacy-text-metrics',
  '1.0.0',
);

module.exports.__testables = {
  APP_THEME,
  EDIT_TEXT_STYLE,
  LEGACY_TEXT_ITEMS,
  TEXT_VIEW_STYLE,
  setLegacyTextMetrics,
};
