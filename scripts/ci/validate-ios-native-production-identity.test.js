import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const repo = path.resolve(import.meta.dir, "../..");
const native = path.join(repo, "apps/ios-native");
const read = (relative) => readFileSync(path.join(repo, relative), "utf8");
const group = "group.tech.dongdongbh.mindwtr";

const parseOpenStep = (text) => {
  const tokens = [...text.replace(/^\/\/[^\n]*\n/, "").matchAll(/\s*(?:\/\*[\s\S]*?\*\/|"((?:[^"\\]|\\.)*)"|([A-Za-z0-9_$/:.\-+<>]+)|([{}();=,]))/g)]
    .filter((match) => match[1] !== undefined || match[2] !== undefined || match[3] !== undefined)
    .map((match) => (match[3] !== undefined ? { punct: match[3] } : { value: match[1] ?? match[2] }));
  let position = 0;
  const value = () => {
    const token = tokens[position++];
    if (token.value !== undefined) return token.value;
    if (token.punct === "{") {
      const object = {};
      while (tokens[position].punct !== "}") {
        const key = value();
        position++;
        object[key] = value();
        position++;
      }
      position++;
      return object;
    }
    if (token.punct === "(") {
      const list = [];
      while (tokens[position].punct !== ")") {
        list.push(value());
        if (tokens[position].punct === ",") position++;
      }
      position++;
      return list;
    }
    throw new Error("Unexpected token " + token.punct);
  };
  return value();
};

const project = parseOpenStep(read("apps/ios-native/MindwtrNative.xcodeproj/project.pbxproj"));
const objects = project.objects;
const root = objects[project.rootObject];
const targets = Object.fromEntries(root.targets.map((key) => [objects[key].name, { key, ...objects[key] }]));
const configurations = (target) =>
  Object.fromEntries(objects[target.buildConfigurationList].buildConfigurations.map((key) => [objects[key].name, objects[key].buildSettings]));
const sources = (target) =>
  target.buildPhases.map((key) => objects[key]).filter((phase) => phase.isa === "PBXSourcesBuildPhase")
    .flatMap((phase) => phase.files.map((build) => objects[objects[build].fileRef].path));
const groups = (relative) => [...read(relative).matchAll(/<string>(group\.[^<]+)<\/string>/g)].map((match) => match[1]);

const extensions = {
  MindwtrWidgets: {
    bundle: "tech.dongdongbh.mindwtr.MindwtrWidgets",
    profile: "Mindwtr_iOS_Widget_AppStore",
    info: "../mobile/widgets-ios/Info.plist",
    entitlements: "../mobile/widgets-ios/MindwtrWidgets.entitlements",
    sources: [
      ...readdirSync(path.join(repo, "apps/mobile/widgets-ios")).filter((name) => name.endsWith(".swift")).map((name) => "../mobile/widgets-ios/" + name),
      "../mobile/modules/ios-widget/ios/MindwtrWidgetActionStore.swift",
      "../mobile/modules/ios-widget/ios/MindwtrWidgetTaskItem.swift",
    ],
    devSources: "WIDGET_SOURCES",
  },
  ShareExtension: {
    bundle: "tech.dongdongbh.mindwtr.share-extension",
    profile: "Mindwtr_ShareExtension_AppStore",
    info: "ShareExtension/Info.plist",
    entitlements: "ShareExtension/Mindwtr.entitlements",
    devSources: "SHARE_SOURCES",
  },
};
const devSources = (name) => [...read("apps/ios-native/scripts/create-dev-project.py")
  .match(new RegExp(name + " = \\(([\\s\\S]*?)\\)"))[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);

test("every file reference belongs to at most one group, as Xcode requires", () => {
  const members = Object.values(objects).filter((item) => item.isa === "PBXGroup" || item.isa === "PBXVariantGroup")
    .flatMap((item) => item.children);
  expect(members.length).toBe(new Set(members).size);
});

test("the production app keeps RN's identity, App Store profile and App Group", () => {
  const app = targets.MindwtrNative;
  for (const settings of Object.values(configurations(app))) {
    expect(settings.PRODUCT_BUNDLE_IDENTIFIER).toBe("tech.dongdongbh.mindwtr");
    expect(settings["CODE_SIGN_ENTITLEMENTS[sdk=iphoneos*]"]).toBe("App/Mindwtr.entitlements");
  }
  expect(configurations(app).Release["PROVISIONING_PROFILE_SPECIFIER[sdk=iphoneos*]"]).toBe("Mindwtr_iOS_AppStore");
  expect(groups("apps/ios-native/App/Mindwtr.entitlements")).toEqual([group]);
  expect(read("apps/mobile/app.json")).toContain(`"iosAppGroupIdentifier": "${group}"`);
  expect(read("apps/ios-native/Sources/MindwtrNativeCore/NativeWidgetFamilyPublisher.swift")).toContain(`public static let group = "${group}"`);
  expect(read("apps/mobile/modules/ios-widget/ios/MindwtrWidgetActionStore.swift")).toContain(`#else\n    static let appGroupIdentifier = "${group}"`);
});

test("each production extension keeps RN's identity, profile, App Group, sources and embedding", () => {
  const app = targets.MindwtrNative;
  const embedded = app.buildPhases.map((key) => objects[key]).filter((phase) => phase.isa === "PBXCopyFilesBuildPhase" && phase.dstSubfolderSpec === "13")
    .flatMap((phase) => phase.files.map((build) => objects[build].fileRef));
  const dependencies = app.dependencies.map((key) => objects[key].target);
  const generator = read("apps/ios-native/scripts/create-dev-project.py");
  for (const [name, expected] of Object.entries(extensions)) {
    const target = targets[name];
    expect(target?.productType).toBe("com.apple.product-type.app-extension");
    for (const settings of Object.values(configurations(target))) {
      expect(settings.PRODUCT_BUNDLE_IDENTIFIER).toBe(expected.bundle);
      expect(settings.INFOPLIST_FILE).toBe(expected.info);
      expect(settings["CODE_SIGN_ENTITLEMENTS[sdk=iphoneos*]"]).toBe(expected.entitlements);
      expect(settings.SWIFT_ACTIVE_COMPILATION_CONDITIONS ?? "").not.toContain("MINDWTR_NATIVE_DEV");
    }
    expect(configurations(target).Release["PROVISIONING_PROFILE_SPECIFIER[sdk=iphoneos*]"]).toBe(expected.profile);
    expect(groups(path.relative(repo, path.join(native, expected.entitlements)))).toEqual([group]);
    expect(new Set(sources(target))).toEqual(new Set(expected.sources ?? devSources(expected.devSources)));
    expect(new Set(devSources(expected.devSources))).toEqual(new Set(sources(target)));
    expect(embedded).toContain(target.productReference);
    expect(dependencies).toContain(target.key);
    expect(generator).toContain(`"${name}": "${expected.bundle}"`);
    expect(configurations(target).Release.MINDWTR_DISPLAY_NAME ?? "Mindwtr").toBe("Mindwtr");
  }
});

test("the production Watch app and its widgets keep RN's identities, profiles, group and embedding", () => {
  const watchGroup = "group.tech.dongdongbh.mindwtr.watch";
  expect(read(".github/workflows/release-ios-appstore.yml")).toContain(`EXPECTED_WATCH_APP_GROUP: ${watchGroup}`);
  const generator = read("apps/ios-native/scripts/create-dev-project.py");
  const resources = "../mobile/targets/watch/Resources/";
  const watchSources = (folder) => [folder, "Shared"].flatMap((name) =>
    readdirSync(path.join(repo, "apps/mobile/targets/watch", name)).filter((file) => file.endsWith(".swift"))
      .map((file) => `../mobile/targets/watch/${name}/${file}`));
  const expected = {
    MindwtrWatch: { bundle: "tech.dongdongbh.mindwtr.watchkitapp", profile: "Mindwtr Watch App Store", kind: "Watch", folder: "App",
      parent: "MindwtrNative", subfolder: "16", destination: "$(CONTENTS_FOLDER_PATH)/Watch" },
    MindwtrWatchWidgets: { bundle: "tech.dongdongbh.mindwtr.watchkitapp.widgets", profile: "Mindwtr Watch Widgets App Store", kind: "Widgets",
      folder: "Widgets", parent: "MindwtrWatch", subfolder: "13", destination: "" },
  };
  for (const [name, item] of Object.entries(expected)) {
    const target = targets[name];
    for (const settings of Object.values(configurations(target))) {
      expect(settings.PRODUCT_BUNDLE_IDENTIFIER).toBe(item.bundle);
      expect(settings.MINDWTR_HOST_BUNDLE_IDENTIFIER).toBe("tech.dongdongbh.mindwtr");
      expect(settings.MINDWTR_WATCH_APP_GROUP).toBe(watchGroup);
      expect(settings.INFOPLIST_FILE).toBe(`${resources}${item.kind}-Info.plist`);
      expect(settings.CODE_SIGN_ENTITLEMENTS).toBe(`${resources}${item.kind}.entitlements`);
    }
    expect(configurations(target).Release["PROVISIONING_PROFILE_SPECIFIER[sdk=watchos*]"]).toBe(item.profile);
    expect(new Set(sources(target))).toEqual(new Set(watchSources(item.folder)));
    const parent = targets[item.parent];
    expect(parent.dependencies.map((key) => objects[key].target)).toContain(target.key);
    const embed = parent.buildPhases.map((key) => objects[key])
      .find((phase) => phase.isa === "PBXCopyFilesBuildPhase" && phase.files.some((build) => objects[build].fileRef === target.productReference));
    expect([embed.dstSubfolderSpec, embed.dstPath]).toEqual([item.subfolder, item.destination]);
    expect(generator).toContain(`"${name}": "${item.bundle}"`);
  }
  expect(read("apps/ios-native/App/Info.plist")).toMatch(/<key>MindwtrWatchEnabled<\/key>\s*<true\/>/);
});
