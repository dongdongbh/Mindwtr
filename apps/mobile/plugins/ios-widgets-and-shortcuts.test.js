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
  it('keeps repeated prebuilds and new Swift files in the widget target with group-relative paths', () => {
    const project = require('xcode').project('fixture.pbxproj');
    project.hash = { project: { objects: {
      PBXNativeTarget: {
        APP: { buildPhases: [] },
        WIDGET: { buildPhases: [] },
      },
      PBXBuildFile: {}, PBXFileReference: {}, PBXGroup: {},
    } } };
    project.addBuildPhase([], 'PBXSourcesBuildPhase', 'Sources', 'APP');
    // Older generated projects named this phase after the target.
    project.addBuildPhase(['Existing.swift'], 'PBXSourcesBuildPhase', 'MindwtrWidgets', 'WIDGET');
    const group = project.addPbxGroup(['Existing.swift'], 'MindwtrWidgets', 'MindwtrWidgets');
    const options = {
      swiftFiles: ['Existing.swift', 'New.swift'], groupKey: group.uuid, targetUuid: 'WIDGET',
    };

    expect(ensureWidgetSwiftSourcesInTarget(project, options)).toEqual(['New.swift']);
    expect(ensureWidgetSwiftSourcesInTarget(project, options)).toEqual([]);
    expect(project.pbxSourcesBuildPhaseObj('APP').files).toHaveLength(0);
    expect(project.pbxSourcesBuildPhaseObj('WIDGET').files).toHaveLength(2);
    const references = Object.values(project.pbxFileReferenceSection()).filter((entry) => typeof entry === 'object');
    expect(references.map((entry) => entry.path.replaceAll('"', ''))).toEqual(['Existing.swift', 'New.swift']);
  });

  it('ships saved-list Shortcuts with the existing widget catalog and preserves Open List', () => {
    const dir = path.resolve(__dirname, '..', APP_INTENTS_FOLDER);
    expect(collectSwiftFiles(dir)).toContain('MindwtrSavedListCatalog.swift');
    const source = fs.readFileSync(path.join(dir, 'MindwtrSiriCaptureIntents.swift'), 'utf8');
    expect(source).toContain('struct MindwtrOpenSavedListIntent: AppIntent');
    expect(source).toContain('var list: MindwtrSavedListEntity');
    expect(source).toContain('var list: MindwtrShortcutList');
    expect(source).toContain('MindwtrSavedListCatalog.destination(id: list.id)');
  });

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
    const actionStoreSource = fs.readFileSync(
      path.resolve(__dirname, '..', IOS_WIDGET_MODULE_FOLDER, SHARED_WIDGET_ACTION_STORE),
      'utf8'
    );

    expect(tasksSource).toContain('let sections: [MindwtrWidgetSection]?');
    expect(tasksSource).toContain('let lists: [String: MindwtrWidgetListPayload]?');
    expect(tasksSource).toContain('let listTitles: [String: String]?');
    expect(tasksSource).toContain('let completionToken: String?');
    expect(tasksSource).toContain('let completeLabel: String?');
    expect(tasksSource).toContain('nonEmpty(completeLabel) ?? "Complete"');
    expect(tasksSource).toContain('pendingAction: pendingAction(for: item)');
    expect(tasksSource).toContain('.strikethrough(pendingAction != nil)');
    expect(tasksSource).toContain('item.openUri ?? payload.focusUri');
    expect(tasksSource).toContain('widgetFamily != .systemSmall');
    expect(tasksSource).toContain('StaticConfiguration(kind: kind');
    expect(tasksSource).toContain('if #available(iOSApplicationExtension 17.0, iOS 17.0, *)');
    expect(tasksSource).toContain('AppIntentConfiguration(');
    expect(tasksSource).toContain('MindwtrWidgetActionProjection.resolvedListId(');
    expect(tasksSource).toContain('MindwtrWidgetActionProjection.timelineDates(');
    expect(actionStoreSource).toContain('action.taskId == identity.taskId');
    expect(actionStoreSource).toContain('action.token == token');
    expect(actionStoreSource).toContain('now < action.notBefore');
    expect(tasksSource).not.toContain('familyTaskCap');
    expect(tasksSource).not.toContain('.claimReady(');
    expect(tasksSource).not.toContain('.acknowledge(');

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
      expect(configuration).toContain('.contentMarginsDisabled()');
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
    expect(bundleSource).toContain('MindwtrCompactWidget()');
  });

  it('opens canonical Focus from blank space in every Tasks and Compact family while keeping explicit destinations', () => {
    const widgetsDir = path.resolve(__dirname, '..', 'widgets-ios');
    const tasksSource = fs.readFileSync(path.join(widgetsDir, 'MindwtrTasksWidget.swift'), 'utf8');
    const compactSource = fs.readFileSync(path.join(widgetsDir, 'MindwtrCompactWidget.swift'), 'utf8');
    const defaultURL = '.widgetURL(safeMindwtrURL(MindwtrWidgetListNavigation.defaultDestination))';

    // Selecting a list replaces focusUri, so it cannot be the blank-space route.
    expect(tasksSource).toContain('focusUri: nonEmpty(openUri) ?? focusUri');
    for (const source of [tasksSource, compactSource]) {
      expect(source).toContain(defaultURL);
      expect(source.match(/\.widgetURL\(/g)).toHaveLength(1);
      expect(source).not.toContain('widgetFamily == .systemSmall ? safeMindwtrURL(payload.focusUri)');
      expect(source).toContain('Link(destination: safeMindwtrURL(payload.focusUri))');
      expect(source).toContain('Link(destination: safeMindwtrURL(payload.quickCaptureUri))');
    }
    expect(tasksSource).toMatch(/Link\(destination: safeMindwtrURL\(payload\.focusUri\)\) \{\s+widgetHeader\(/);
    expect(compactSource).toMatch(/Link\(destination: safeMindwtrURL\(payload\.focusUri\)\) \{\s+compactHeader\(/);
    expect(tasksSource).not.toContain('if widgetFamily == .systemSmall {\n                        widgetHeader(');
    expect(compactSource).not.toContain('if widgetFamily == .systemSmall {\n                        compactHeader(');
    expect(tasksSource).toContain('Link(destination: safeMindwtrURL(MindwtrWidgetListNavigation.defaultDestination))');
    expect(tasksSource).toContain('Link(destination: safeMindwtrURL(item.openUri ?? payload.focusUri))');
    expect(compactSource).toContain('Link(destination: safeMindwtrURL(item.openUri ?? payload.focusUri))');
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
        hash: { project: { objects: { PBXNativeTarget: { WIDGET_TARGET: { buildPhases: [] } } } } },
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
        ['MindwtrTasksWidget.swift', { target: 'WIDGET_TARGET' }, 'WIDGET_GROUP'],
        ['MindwtrTasksWidgetIntents.swift', { target: 'WIDGET_TARGET' }, 'WIDGET_GROUP'],
        [SHARED_WIDGET_ACTION_STORE, { target: 'WIDGET_TARGET' }, 'WIDGET_GROUP'],
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
    expect(source).toContain('let deepLink: String?');
    expect(source).toContain('validatedTaskURL(item.deepLink, expectedTaskId: item.id)');
    expect(source).toContain('URLQueryItem(name: "task", value: taskId)');
    expect(source).toContain('return identifiers.compactMap { itemById[$0] }');

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

  it('reports bounded or stale snapshot reads and refuses ambiguous project names', () => {
    const sourceDir = path.resolve(__dirname, '..', APP_INTENTS_FOLDER);
    const source = fs.readFileSync(
      path.join(sourceDir, 'MindwtrSiriCaptureIntents.swift'),
      'utf8'
    );

    expect(source).toContain('private static let staleAfter: TimeInterval = 24 * 60 * 60');
    expect(source).toContain('static func knownOmittedTaskCount(forList list: MindwtrGetTasksList) -> Int?');
    expect(source).toContain('let omittedCount = (match["coverage"] as? [String: Any])?["omitted"] as? NSNumber');
    expect(source).toContain('case ambiguous');
    expect(source).toContain('More than one project has that name.');
    expect(source).toContain('eligible task(s) from this \\(sourceLabel) were omitted');
    expect(source).toContain('This \\(sourceLabel) may contain more tasks.');
    expect(source).toContain('task(s) in a stale snapshot.');
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

// The Control Center control names its action in the widget extension, but iOS runs a
// foreground control intent inside the app, and only if the app target has a type with the same
// name. One copy alone is a control that does nothing (feedback 4bf8d547).
describe('Control Center quick capture intent', () => {
  const read = (relativePath) => fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
  const intentBlock = (source) => {
    const start = source.indexOf('struct MindwtrOpenQuickCaptureIntent: AppIntent');
    expect(start).toBeGreaterThan(-1);
    return source.slice(start, source.indexOf('\n}\n', start));
  };

  it('exists in both targets with the same title and foreground mode', () => {
    const appCopy = intentBlock(read('ios-app-intents/MindwtrSiriCaptureIntents.swift'));
    const extensionCopy = intentBlock(read('widgets-ios/MindwtrCaptureLockWidget.swift'));

    for (const copy of [appCopy, extensionCopy]) {
      expect(copy).toContain('"Add Task"');
      expect(copy).toContain('.foreground(.immediate)');
      expect(copy).toMatch(/openAppWhenRun: Bool \{\s*true/);
      expect(copy).toContain('-> some IntentResult {');
    }
    // Only the app can open the screen; the extension copy must not try to open a URL.
    expect(appCopy).toContain('MindwtrSiriCaptureLauncher.openQuickCapture()');
    expect(extensionCopy).not.toContain('OpenURLIntent(');
  });
});
