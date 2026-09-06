import { describe, expect, it } from 'vitest';

const plugin = require('./android-quick-settings-tile');

const {
  buildCaptureTileServiceSource,
  buildTileIconXml,
  buildTileStringsXml,
  ensureCaptureTileService,
} = plugin.__testables;

describe('android-quick-settings-tile', () => {
  it('generates a TileService that opens the native quick-capture dialog', () => {
    const source = buildCaptureTileServiceSource('tech.dongdongbh.mindwtr');

    expect(source).toContain('class CaptureTileService : TileService()');
    expect(source).toContain('tech.dongdongbh.mindwtr.androidwidget.QuickCaptureActivity');
    expect(source).not.toContain('capture-quick');
    expect(source).toContain('unlockAndRun { launchQuickCapture() }');
    expect(source).toContain('Build.VERSION_CODES.UPSIDE_DOWN_CAKE');
    expect(source).toContain('PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE');
    expect(source).toContain('startActivityAndCollapse(pendingIntent)');
    expect(source).toContain('startActivityAndCollapse(intent)');
    expect(source).toContain('setClassName(packageName, QUICK_CAPTURE_ACTIVITY)');
  });

  it('adds the protected quick settings service to the Android manifest idempotently', () => {
    const manifest = {
      manifest: {
        application: [
          {
            service: [],
          },
        ],
      },
    };

    ensureCaptureTileService(manifest);
    const once = JSON.stringify(manifest);
    ensureCaptureTileService(manifest);

    expect(JSON.stringify(manifest)).toBe(once);
    expect(manifest.manifest.application[0].service).toHaveLength(1);
    expect(manifest.manifest.application[0].service[0]).toEqual({
      $: {
        'android:name': '.quicksettings.CaptureTileService',
        'android:label': '@string/quick_settings_capture_tile_label',
        'android:icon': '@drawable/ic_quick_settings_capture',
        'android:permission': 'android.permission.BIND_QUICK_SETTINGS_TILE',
        'android:exported': 'true',
      },
      'intent-filter': [
        {
          action: [
            {
              $: {
                'android:name': 'android.service.quicksettings.action.QS_TILE',
              },
            },
          ],
        },
      ],
    });
  });

  it('generates the tile string and icon resources', () => {
    expect(buildTileStringsXml()).toContain('name="quick_settings_capture_tile_label"');
    expect(buildTileStringsXml()).toContain('Capture');
    expect(buildTileIconXml()).toContain('<vector');
    expect(buildTileIconXml()).toContain('android:fillColor="#FFFFFFFF"');
  });
});
