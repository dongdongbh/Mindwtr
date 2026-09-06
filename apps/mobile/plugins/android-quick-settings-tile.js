const fs = require('fs');
const path = require('path');
const { withAndroidManifest, withDangerousMod } = require('@expo/config-plugins');

// The native quick-capture dialog (modules/android-widget, #1169): saves to the
// Inbox queue and closes without bringing the app forward.
const QUICK_CAPTURE_ACTIVITY = 'tech.dongdongbh.mindwtr.androidwidget.QuickCaptureActivity';
const SERVICE_NAME = '.quicksettings.CaptureTileService';
const SERVICE_PERMISSION = 'android.permission.BIND_QUICK_SETTINGS_TILE';
const QS_TILE_ACTION = 'android.service.quicksettings.action.QS_TILE';
const TILE_LABEL = '@string/quick_settings_capture_tile_label';
const TILE_ICON = '@drawable/ic_quick_settings_capture';
const STRINGS_FILE_NAME = 'mindwtr_quick_settings_tile_strings.xml';
const ICON_FILE_NAME = 'ic_quick_settings_capture.xml';

const buildTileStringsXml = () => `<?xml version="1.0" encoding="utf-8"?>
<resources>
  <string name="quick_settings_capture_tile_label" translatable="false">Capture</string>
  <string name="quick_settings_capture_tile_description" translatable="false">Open Mindwtr quick capture</string>
</resources>
`;

const buildTileIconXml = () => `<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="24dp"
    android:height="24dp"
    android:viewportWidth="24"
    android:viewportHeight="24">
  <path
      android:fillColor="#FFFFFFFF"
      android:pathData="M12,3C7.03,3 3,7.03 3,12s4.03,9 9,9 9,-4.03 9,-9 -4.03,-9 -9,-9zM12,5c3.86,0 7,3.14 7,7s-3.14,7 -7,7 -7,-3.14 -7,-7 3.14,-7 7,-7zM11,8h2v3h3v2h-3v3h-2v-3H8v-2h3z" />
</vector>
`;

const buildCaptureTileServiceSource = (packageName) => `package ${packageName}.quicksettings

import android.app.PendingIntent
import android.content.Intent
import android.os.Build
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService
import ${packageName}.R

class CaptureTileService : TileService() {
  override fun onTileAdded() {
    super.onTileAdded()
    updateTileState()
  }

  override fun onStartListening() {
    super.onStartListening()
    updateTileState()
  }

  override fun onClick() {
    super.onClick()

    if (isLocked) {
      unlockAndRun { launchQuickCapture() }
      return
    }

    launchQuickCapture()
  }

  private fun updateTileState() {
    qsTile?.apply {
      label = getString(R.string.quick_settings_capture_tile_label)
      contentDescription = getString(R.string.quick_settings_capture_tile_description)
      state = Tile.STATE_ACTIVE
      updateTile()
    }
  }

  @Suppress("DEPRECATION")
  private fun launchQuickCapture() {
    val intent = Intent().apply {
      setClassName(packageName, QUICK_CAPTURE_ACTIVITY)
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      val pendingIntent = PendingIntent.getActivity(
        this,
        CAPTURE_REQUEST_CODE,
        intent,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
      )
      startActivityAndCollapse(pendingIntent)
    } else {
      startActivityAndCollapse(intent)
    }
  }

  companion object {
    private const val QUICK_CAPTURE_ACTIVITY = "${QUICK_CAPTURE_ACTIVITY}"
    private const val CAPTURE_REQUEST_CODE = 461
  }
}
`;

const findCaptureTileService = (services) =>
  services.find((service) => service?.$?.['android:name'] === SERVICE_NAME);

const ensureQsTileIntentFilter = (service) => {
  if (!Array.isArray(service['intent-filter'])) {
    service['intent-filter'] = [];
  }

  const existingFilter = service['intent-filter'].find((filter) => {
    const actions = Array.isArray(filter?.action) ? filter.action : [];
    return actions.some((action) => action?.$?.['android:name'] === QS_TILE_ACTION);
  });

  if (existingFilter) return;

  service['intent-filter'].push({
    action: [{ $: { 'android:name': QS_TILE_ACTION } }],
  });
};

const ensureCaptureTileService = (androidManifest) => {
  const application = androidManifest?.manifest?.application?.[0];
  if (!application) return androidManifest;

  if (!Array.isArray(application.service)) {
    application.service = [];
  }

  const service = findCaptureTileService(application.service) ?? {
    $: { 'android:name': SERVICE_NAME },
  };

  service.$ = {
    ...service.$,
    'android:name': SERVICE_NAME,
    'android:label': TILE_LABEL,
    'android:icon': TILE_ICON,
    'android:permission': SERVICE_PERMISSION,
    'android:exported': 'true',
  };
  ensureQsTileIntentFilter(service);

  if (!application.service.includes(service)) {
    application.service.push(service);
  }

  return androidManifest;
};

module.exports = function withAndroidQuickSettingsTile(config) {
  const withManifest = withAndroidManifest(config, (cfg) => {
    ensureCaptureTileService(cfg.modResults);
    return cfg;
  });

  return withDangerousMod(withManifest, [
    'android',
    async (cfg) => {
      const packageName = cfg.android?.package || cfg.modRequest.projectName;
      if (!packageName) return cfg;

      const mainRoot = path.join(cfg.modRequest.platformProjectRoot, 'app', 'src', 'main');
      const packageDir = packageName.replace(/\./g, path.sep);
      const serviceDir = path.join(mainRoot, 'java', packageDir, 'quicksettings');
      const valuesDir = path.join(mainRoot, 'res', 'values');
      const drawableDir = path.join(mainRoot, 'res', 'drawable');

      await fs.promises.mkdir(serviceDir, { recursive: true });
      await fs.promises.mkdir(valuesDir, { recursive: true });
      await fs.promises.mkdir(drawableDir, { recursive: true });
      await fs.promises.writeFile(
        path.join(serviceDir, 'CaptureTileService.kt'),
        buildCaptureTileServiceSource(packageName),
        'utf8'
      );
      await fs.promises.writeFile(path.join(valuesDir, STRINGS_FILE_NAME), buildTileStringsXml(), 'utf8');
      await fs.promises.writeFile(path.join(drawableDir, ICON_FILE_NAME), buildTileIconXml(), 'utf8');

      return cfg;
    },
  ]);
};

module.exports.__testables = {
  buildCaptureTileServiceSource,
  buildTileIconXml,
  buildTileStringsXml,
  ensureCaptureTileService,
};
