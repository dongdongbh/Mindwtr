import { describe, expect, it } from 'vitest';

const fs = require('fs');
const os = require('os');
const path = require('path');
const plugin = require('./ios-widgets-and-shortcuts');

const {
  APP_INTENTS_FOLDER,
  IOS_WIDGET_MODULE_FOLDER,
  SHARED_WIDGET_ACTION_STORE,
  SIRI_CAPTURE_SHORTCUTS_PROVIDER,
  SPOTLIGHT_INDEXER,
  addSiriShortcutsRegistrationToAppDelegate,
  collectSwiftFiles,
  copySharedWidgetActionStore,
  ensureSourceFileInTarget,
  ensureWidgetSwiftSourcesInTarget,
} = plugin.__testables;

describe('ios-widgets-and-shortcuts', () => {
  it('ships the rich configurable Tasks widget with legacy payload and iOS 15 fallbacks', () => {
    const widgetsDir = path.resolve(__dirname, '..', 'widgets-ios');
    const tasksSource = fs.readFileSync(
      path.join(widgetsDir, 'MindwtrTasksWidget.swift'),
      'utf8'
    );
    const intentsSource = fs.readFileSync(
      path.join(widgetsDir, 'MindwtrTasksWidgetIntents.swift'),
      'utf8'
    );

    expect(tasksSource).toContain('let sections: [MindwtrWidgetSection]?');
    expect(tasksSource).toContain('let lists: [String: MindwtrWidgetListPayload]?');
    expect(tasksSource).toContain('let listTitles: [String: String]?');
    expect(tasksSource).toContain('let completionToken: String?');
    expect(tasksSource).toContain('let completeLabel: String?');
    expect(tasksSource).toContain('nonEmpty(completeLabel) ?? "Complete"');
    expect(tasksSource).toContain('pendingAction: pendingAction(for: item.id)');
    expect(tasksSource).toContain('.strikethrough(pendingAction != nil)');
    expect(tasksSource).toContain('item.openUri ?? payload.focusUri');
    expect(tasksSource).toContain('widgetFamily != .systemSmall');
    expect(tasksSource).toContain('.mindwtrSmallWidgetURL(widgetFamily == .systemSmall');
    expect(tasksSource).toContain('StaticConfiguration(kind: kind');
    expect(tasksSource).toContain('if #available(iOSApplicationExtension 17.0, iOS 17.0, *)');
    expect(tasksSource).toContain('AppIntentConfiguration(');

    expect(intentsSource).toContain('struct MindwtrTasksWidgetConfigurationIntent: WidgetConfigurationIntent');
    expect(intentsSource).toContain('struct MindwtrTasksWidgetAppIntentProvider: AppIntentTimelineProvider');
    for (const listId of ['focus', 'inbox', 'next', 'waiting', 'someday']) {
      expect(intentsSource).toContain(`"${listId}"`);
    }
    expect(intentsSource).toContain('payload.savedFilters ?? []');
    expect(intentsSource).toContain('MindwtrTasksWidgetSnapshotStore.contains(');
    expect(intentsSource).toContain('guard try store.cancel(id: actionId) else {');
    expect(intentsSource).not.toContain('store.pendingActions().contains');
  });

  it('selects one Tasks configuration at launch while preserving the installed widget kind', () => {
    const widgetsDir = path.resolve(__dirname, '..', 'widgets-ios');
    const tasksSource = fs.readFileSync(path.join(widgetsDir, 'MindwtrTasksWidget.swift'), 'utf8');
    const bundleSource = fs.readFileSync(path.join(widgetsDir, 'MindwtrWidgetsBundle.swift'), 'utf8');
    const configurations = tasksSource.slice(tasksSource.indexOf('struct MindwtrTasksWidget: Widget'));
    const [modern, legacy] = configurations.split('struct MindwtrLegacyTasksWidget: Widget');
    expect(modern).toContain('AppIntentConfiguration(');
    expect(modern).not.toContain('StaticConfiguration(');
    expect(legacy).toContain('StaticConfiguration(');
    for (const configuration of [modern, legacy]) {
      expect(configuration).toContain('let kind: String = mindwtrWidgetKind');
      expect(configuration).not.toContain('if #available');
    }
    expect(bundleSource).toContain('enum MindwtrWidgetsEntryPoint');
    expect(bundleSource).toMatch(/if #available\(iOSApplicationExtension 17\.0, iOS 17\.0, \*\) \{\s+MindwtrWidgetsBundle\.main\(\)\s+\} else \{\s+MindwtrLegacyWidgetsBundle\.main\(\)/);
    expect(bundleSource.match(/MindwtrCompactWidget\(\)/g)).toHaveLength(2);
  });

  it('ships a separate flat Compact gallery kind without chooser or inline completion', () => {
    const widgetsDir = path.resolve(__dirname, '..', 'widgets-ios');
    const compactSource = fs.readFileSync(
      path.join(widgetsDir, 'MindwtrCompactWidget.swift'),
      'utf8'
    );
    const bundleSource = fs.readFileSync(
      path.join(widgetsDir, 'MindwtrWidgetsBundle.swift'),
      'utf8'
    );

    expect(compactSource).toContain('let mindwtrCompactWidgetKind = "MindwtrCompactWidget"');
    expect(compactSource).toContain('sections.flatMap(\\.items)');
    expect(compactSource).toContain('.configurationDisplayName("Compact")');
    expect(compactSource).not.toContain('Button(intent:');
    expect(compactSource).not.toContain('WidgetConfigurationIntent');
    expect(compactSource).toContain('widgetFamily != .systemSmall');
    expect(compactSource).toContain('Link(destination: safeMindwtrURL(payload.focusUri))');
    expect(compactSource).toContain('.mindwtrCompactWidgetURL(widgetFamily == .systemSmall');
    expect(bundleSource).toContain('MindwtrCompactWidget()');
  });

  it('drops rows that do not fit without presenting a false empty state at large text sizes', () => {
    const widgetsDir = path.resolve(__dirname, '..', 'widgets-ios');
    const tasksSource = fs.readFileSync(
      path.join(widgetsDir, 'MindwtrTasksWidget.swift'),
      'utf8'
    );
    const compactSource = fs.readFileSync(
      path.join(widgetsDir, 'MindwtrCompactWidget.swift'),
      'utf8'
    );

    expect(tasksSource).toContain('let hasSourceTasks = !sourceSections(for: payload).isEmpty');
    expect(tasksSource).toContain('if !hasSourceTasks {');
    expect(tasksSource).toContain('let fittingRows = max(0, Int(floor(');
    expect(tasksSource).not.toContain('fittingRows = 1');
    expect(tasksSource).toContain('availableHeight - metrics.padding * 2 - metrics.headerHeight - metrics.sectionSpacing');

    expect(compactSource).toContain('let sourceItems = focusItems(payload)');
    expect(compactSource).toContain('if sourceItems.isEmpty {');
    expect(compactSource).toContain('} else if !items.isEmpty {');
    expect(compactSource).toContain('(available + metrics.rowSpacing) / (metrics.rowHeight + metrics.rowSpacing)');
  });

  it('copies the canonical action store and registers every new Swift source only in the widget target', () => {
    const mobileRoot = path.resolve(__dirname, '..');
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mindwtr-ios-widget-'));
    try {
      const copied = copySharedWidgetActionStore(mobileRoot, temporaryRoot);
      expect(copied).toBe(SHARED_WIDGET_ACTION_STORE);
      expect(fs.readFileSync(path.join(temporaryRoot, copied), 'utf8')).toBe(
        fs.readFileSync(
          path.join(mobileRoot, IOS_WIDGET_MODULE_FOLDER, SHARED_WIDGET_ACTION_STORE),
          'utf8'
        )
      );

      const calls = [];
      const xcodeProject = {
        hasFile: () => false,
        addSourceFile: (...args) => calls.push(args),
      };
      const added = ensureWidgetSwiftSourcesInTarget(xcodeProject, {
        swiftFiles: [
          'MindwtrTasksWidget.swift',
          'MindwtrTasksWidgetIntents.swift',
          SHARED_WIDGET_ACTION_STORE,
        ],
        groupKey: 'WIDGET_GROUP',
        targetUuid: 'WIDGET_TARGET',
      });

      expect(added).toEqual([
        'MindwtrTasksWidget.swift',
        'MindwtrTasksWidgetIntents.swift',
        SHARED_WIDGET_ACTION_STORE,
      ]);
      expect(calls).toEqual([
        ['MindwtrWidgets/MindwtrTasksWidget.swift', { target: 'WIDGET_TARGET' }, 'WIDGET_GROUP'],
        ['MindwtrWidgets/MindwtrTasksWidgetIntents.swift', { target: 'WIDGET_TARGET' }, 'WIDGET_GROUP'],
        [`MindwtrWidgets/${SHARED_WIDGET_ACTION_STORE}`, { target: 'WIDGET_TARGET' }, 'WIDGET_GROUP'],
      ]);
      expect(calls.some(([, options]) => options.target !== 'WIDGET_TARGET')).toBe(false);
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it('ships App Intents sources for Siri Inbox capture and v1 Shortcuts actions', () => {
    const sourceDir = path.resolve(__dirname, '..', APP_INTENTS_FOLDER);
    const source = fs.readFileSync(
      path.join(sourceDir, 'MindwtrSiriCaptureIntents.swift'),
      'utf8'
    );

    expect(collectSwiftFiles(sourceDir)).toContain('MindwtrSiriCaptureIntents.swift');
    expect(source).toContain('struct MindwtrSiriCaptureIntent: AppIntent');
    expect(source).toContain('struct MindwtrOpenListIntent: AppIntent');
    expect(source).toContain('enum MindwtrShortcutList: String, AppEnum');
    expect(source).toContain('struct MindwtrSiriCaptureShortcuts: AppShortcutsProvider');
    expect(source).toContain('"Capture in \\(.applicationName)"');
    const phraseBlock = source.match(/phrases:\s*\[[\s\S]*?\]/)?.[0] ?? '';
    expect(phraseBlock).not.toContain('\\(\\.$task)');
    expect(source).toContain('mindwtr');
    expect(source).toContain('/capture');
    expect(source).toContain('/open-feature');
    expect(source).toContain('requestId');
    expect(source).toContain('UUID().uuidString');
    expect(source).toContain('@Parameter(title: "Project")');
    expect(source).toContain('@Parameter(title: "Tags")');
    expect(source).toContain('URLQueryItem(name: "project"');
    expect(source).toContain('URLQueryItem(name: "tags"');
    expect(source).toContain('case focus');
    expect(source).toContain('case review');
    expect(source).toContain('@Parameter(title: "List", default: MindwtrShortcutList.inbox)');
    expect(source).toContain('var list: MindwtrShortcutList');
    expect(source).not.toContain('var list: MindwtrShortcutList = .inbox');
    expect(source).toContain('.foreground(.immediate)');
  });

  it('ships a background capture intent that only writes the pending-captures queue', () => {
    const sourceDir = path.resolve(__dirname, '..', APP_INTENTS_FOLDER);
    const source = fs.readFileSync(
      path.join(sourceDir, 'MindwtrSiriCaptureIntents.swift'),
      'utf8'
    );

    expect(source).toContain('struct MindwtrBackgroundCaptureIntent: AppIntent');
    expect(source).toContain('"pending-captures"');

    const backgroundIntent = source.slice(source.indexOf('struct MindwtrBackgroundCaptureIntent'));
    // Background capture must never foreground the app or open deep links.
    expect(backgroundIntent).toContain('.background');
    expect(backgroundIntent).not.toContain('.foreground');
    expect(backgroundIntent).not.toContain('UIApplication');
    expect(backgroundIntent).not.toContain('MindwtrSiriCaptureLauncher.open');

    // No SQLite or store writes from Swift: the queue file is the only output.
    expect(source).not.toContain('sqlite');
    expect(source).not.toContain('SQLite');
  });

  it('renames the background capture intent to "Add to Mindwtr" with due/start date params (#980 stage 1)', () => {
    const sourceDir = path.resolve(__dirname, '..', APP_INTENTS_FOLDER);
    const source = fs.readFileSync(
      path.join(sourceDir, 'MindwtrSiriCaptureIntents.swift'),
      'utf8'
    );
    const backgroundIntent = source.slice(
      source.indexOf('struct MindwtrBackgroundCaptureIntent'),
      source.indexOf('// MARK: - Shortcuts snapshot')
    );

    expect(backgroundIntent).toContain('static var title: LocalizedStringResource = "Add to Mindwtr"');
    expect(backgroundIntent).toContain('@Parameter(title: "Due date")');
    expect(backgroundIntent).toContain('var dueDate: Date?');
    expect(backgroundIntent).toContain('@Parameter(title: "Start date")');
    expect(backgroundIntent).toContain('var startDate: Date?');
    expect(backgroundIntent).toContain('\\.$dueDate');
    expect(backgroundIntent).toContain('\\.$startDate');
    expect(backgroundIntent).toContain('dueDate: dueDate');
    expect(backgroundIntent).toContain('startDate: startDate');
    expect(backgroundIntent).toContain('"Added to Mindwtr."');
    // The dialog must not promise a specific project placement -- the drain
    // decides that, and an unknown project falls back to Inbox.
    expect(backgroundIntent).not.toMatch(/dialog:\s*"[^"]*Inbox[^"]*"/);
  });

  it('ships a background, read-only Get Mindwtr Tasks intent over the shortcuts snapshot (#980 stage 2)', () => {
    const sourceDir = path.resolve(__dirname, '..', APP_INTENTS_FOLDER);
    const source = fs.readFileSync(
      path.join(sourceDir, 'MindwtrSiriCaptureIntents.swift'),
      'utf8'
    );

    expect(source).toContain('struct MindwtrGetTasksIntent: AppIntent');
    expect(source).toContain('enum MindwtrGetTasksList: String, AppEnum');
    expect(source).toContain('mindwtr-ios-shortcuts-snapshot');
    expect(source).toContain('UserDefaults(suiteName: appGroup)');

    // The store's `items(forList:)` takes the iOS 16-only `MindwtrGetTasksList`
    // while the deployment target is 15.1 -- the enclosing enum must carry an
    // iOS 16 guard or this is a hard compile error the CI validator can't
    // catch (it only checks IntentModes/phrases/@Parameter defaults, not
    // signature availability).
    expect(source).toContain('@available(iOS 16.0, *)\nprivate enum MindwtrShortcutsSnapshotStore');

    const getTasksIntent = source.slice(source.indexOf('struct MindwtrGetTasksIntent'));
    const getTasksIntentBody = getTasksIntent.slice(0, getTasksIntent.indexOf('\n}\n'));
    expect(getTasksIntentBody).toContain('.background');
    expect(getTasksIntentBody).not.toContain('.foreground');
    expect(getTasksIntentBody).not.toContain('UIApplication');
    // The intent must never touch the store or SQLite -- it only reads the
    // app-maintained snapshot.
    expect(getTasksIntentBody).not.toContain('sqlite');
    expect(getTasksIntentBody).not.toContain('SQLite');
  });

  it('ships a Task entity (iOS 16+) with IndexedEntity Spotlight indexing guarded to iOS 18+ (#980 stage 3)', () => {
    const sourceDir = path.resolve(__dirname, '..', APP_INTENTS_FOLDER);
    const source = fs.readFileSync(
      path.join(sourceDir, 'MindwtrSiriCaptureIntents.swift'),
      'utf8'
    );

    expect(source).toContain('@available(iOS 16.0, *)\nstruct MindwtrTaskEntity: AppEntity');
    expect(source).toContain('static var defaultQuery = MindwtrTaskEntityQuery()');
    expect(source).toContain('struct MindwtrTaskEntityQuery: EntityStringQuery');
    expect(source).toContain('@available(iOS 18.0, *)\nextension MindwtrTaskEntity: IndexedEntity');
    expect(source).toContain('CSSearchableIndex.default().indexAppEntities(');
    expect(source).toContain('@available(iOS 18.0, *)\nenum MindwtrShortcutsSpotlightIndexer');

    // Reindexing must be driven by the app's refresh path, never by an
    // intent's perform().
    const getTasksIntent = source.slice(
      source.indexOf('struct MindwtrGetTasksIntent'),
      source.indexOf('enum MindwtrShortcutsSpotlightIndexer')
    );
    expect(getTasksIntent).not.toContain('reindexIfNeeded');

    // Get Tasks: a project override must be stated in the summary, not just
    // implemented, per the complete-sentence rule.
    expect(getTasksIntent).toContain('overridden by \\(\\.$project) if set');

    // Fixed-format date parsing/formatting needs a fixed locale (Apple
    // QA1480) or non-ASCII digit locales silently drop the date on the RN
    // drain side.
    expect(source).toContain('formatter.locale = Locale(identifier: "en_US_POSIX")');

    // Spotlight must clear stale entries before reindexing -- indexAppEntities
    // is additive and never removes completed/deleted/capped-out tasks on its
    // own.
    const spotlightIndexer = source.slice(source.indexOf('enum MindwtrShortcutsSpotlightIndexer'));
    const deleteIndex = spotlightIndexer.indexOf('deleteAllSearchableItems');
    const indexEntities = spotlightIndexer.indexOf('indexAppEntities(entities)');
    expect(deleteIndex).toBeGreaterThan(-1);
    expect(indexEntities).toBeGreaterThan(deleteIndex);
  });

  it('wires Spotlight reindexing into AppDelegate launch, guarded to iOS 18+, idempotently', () => {
    const appDelegate = `public class AppDelegate: ExpoAppDelegate {
  public override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    bindReactNativeFactory(factory)

    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }
}
`;

    const patched = addSiriShortcutsRegistrationToAppDelegate(appDelegate);

    expect(patched).toContain('if #available(iOS 18.0, *)');
    expect(patched).toContain(`${SPOTLIGHT_INDEXER}.reindexIfNeeded()`);
    expect(addSiriShortcutsRegistrationToAppDelegate(patched)).toBe(patched);
  });

  it('registers App Shortcuts from AppDelegate idempotently', () => {
    const appDelegate = `public class AppDelegate: ExpoAppDelegate {
  public override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    bindReactNativeFactory(factory)

    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }
}
`;

    const patched = addSiriShortcutsRegistrationToAppDelegate(appDelegate);

    expect(patched).toContain('if #available(iOS 16.0, *)');
    expect(patched).toContain(`${SIRI_CAPTURE_SHORTCUTS_PROVIDER}.updateAppShortcutParameters()`);
    expect(addSiriShortcutsRegistrationToAppDelegate(patched)).toBe(patched);
  });

  it('adds App Intents Swift files to the main target once', () => {
    const calls = [];
    const xcodeProject = {
      hasFile: (filePath) => filePath === 'Mindwtr/Existing.swift',
      addSourceFile: (...args) => calls.push(args),
    };

    expect(ensureSourceFileInTarget(xcodeProject, {
      filePath: 'Mindwtr/MindwtrSiriCaptureIntents.swift',
      groupKey: 'MAIN_GROUP',
      targetUuid: 'MAIN_TARGET',
    })).toBe(true);
    expect(ensureSourceFileInTarget(xcodeProject, {
      filePath: 'Mindwtr/Existing.swift',
      groupKey: 'MAIN_GROUP',
      targetUuid: 'MAIN_TARGET',
    })).toBe(false);

    expect(calls).toEqual([
      [
        'Mindwtr/MindwtrSiriCaptureIntents.swift',
        { target: 'MAIN_TARGET' },
        'MAIN_GROUP',
      ],
    ]);
  });
});
