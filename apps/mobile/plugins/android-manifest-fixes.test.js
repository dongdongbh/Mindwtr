import { describe, expect, it } from 'vitest';

const plugin = require('./android-manifest-fixes');

const {
    BACKUP_RULES_XML,
    DATA_EXTRACTION_RULES_XML,
    buildContextIntentFilter,
    ensureBackupRules,
    ensureContextAutomationHeadlessService,
    ensureContextAutomationReceiver,
    removeContextIntentFilters,
    setProfileable,
    mergeToolsRemove,
    ensureConfigChange,
} = plugin.__testables;

describe('android-manifest-fixes', () => {
  it('keeps manifest remove directives idempotent across repeated prebuilds', () => {
    const attribute = 'android:screenOrientation';
    expect(mergeToolsRemove(undefined, attribute)).toBe(attribute);
    expect(mergeToolsRemove(`${attribute}, ${attribute}`, attribute)).toBe(attribute);
    expect(mergeToolsRemove(['android:theme', attribute], attribute)).toBe(`android:theme,${attribute}`);
    expect(mergeToolsRemove(mergeToolsRemove('android:theme', attribute), attribute)).toBe(`android:theme,${attribute}`);
  });
  it('preserves config change handling while adding fold-size transitions idempotently', () => {
    const existing = 'keyboard|orientation|screenSize|screenLayout';
    const updated = ensureConfigChange(existing, 'smallestScreenSize');

    expect(updated).toBe('keyboard|orientation|screenSize|screenLayout|smallestScreenSize');
    expect(ensureConfigChange(updated, 'smallestScreenSize')).toBe(updated);
  });
  it('moves context automation custom actions from MainActivity to a receiver', () => {
    const mainActivity = {
      $: { 'android:name': '.MainActivity' },
      'intent-filter': [
        buildContextIntentFilter(),
        buildContextIntentFilter({ dataScheme: 'mindwtr' }),
        {
          action: [{ $: { 'android:name': 'android.intent.action.VIEW' } }],
          category: [{ $: { 'android:name': 'android.intent.category.DEFAULT' } }],
        },
      ],
    };
    const application = {
      activity: [mainActivity],
    };

    removeContextIntentFilters(mainActivity);
    ensureContextAutomationReceiver(application);
    ensureContextAutomationHeadlessService(application);

    expect(mainActivity['intent-filter']).toHaveLength(1);
    expect(mainActivity['intent-filter'][0].action[0].$['android:name']).toBe('android.intent.action.VIEW');

    expect(application.receiver).toHaveLength(1);
    expect(application.receiver[0].$).toEqual({
      'android:name': 'tech.dongdongbh.mindwtr.contextautomation.ContextAutomationReceiver',
      'android:exported': 'true',
    });
    expect(application.receiver[0]['intent-filter']).toHaveLength(2);

    expect(application.service).toHaveLength(1);
    expect(application.service[0].$).toEqual({
      'android:name': 'tech.dongdongbh.mindwtr.contextautomation.ContextAutomationHeadlessService',
      'android:exported': 'false',
    });
  });

  it('adds profileable shell access for diagnostic Android releases', () => {
    const application = {};

    setProfileable(application, true);

    expect(application.profileable).toEqual([
      {
        $: {
          'android:shell': 'true',
        },
      },
    ]);
  });

  it('takes over the backup rules from expo-secure-store', () => {
    const application = {
      $: {
        'android:fullBackupContent': '@xml/secure_store_backup_rules',
        'android:dataExtractionRules': '@xml/secure_store_data_extraction_rules',
        'android:allowBackup': 'true',
      },
    };

    ensureBackupRules(application);

    expect(application.$['android:fullBackupContent']).toBe('@xml/mindwtr_backup_rules');
    expect(application.$['android:dataExtractionRules']).toBe('@xml/mindwtr_data_extraction_rules');
    expect(application.$['android:allowBackup']).toBe('true');
  });

  it('enrolls nothing in backup or device transfer', () => {
    // expo-secure-store's rules include every sharedpref file, so any new one
    // would be silently enrolled. Ours name a path that does not exist, which
    // is how an exhaustive include list says "nothing" — an empty rule set
    // would mean "everything".
    [BACKUP_RULES_XML, DATA_EXTRACTION_RULES_XML].forEach((xml) => {
      const includes = xml.match(/<include [^>]*\/>/g) ?? [];
      expect(includes.length).toBeGreaterThan(0);
      includes.forEach((include) => {
        expect(include).toContain('path="mindwtr_backup_none"');
      });
      expect(xml).not.toContain('path="."');
    });

    expect(BACKUP_RULES_XML).toContain('<full-backup-content>');
    expect(DATA_EXTRACTION_RULES_XML).toContain('<cloud-backup>');
    expect(DATA_EXTRACTION_RULES_XML).toContain('<device-transfer>');
  });

  it('removes profileable shell access by default', () => {
    const application = {
      profileable: [
        {
          $: {
            'android:shell': 'true',
          },
        },
      ],
    };

    setProfileable(application, false);

    expect(application.profileable).toBeUndefined();
  });
});
