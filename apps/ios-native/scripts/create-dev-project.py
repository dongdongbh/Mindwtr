#!/usr/bin/env python3
"""Generate a fresh sibling native.dev Xcode project. Does not build, sign or install."""
import argparse
import copy
import hashlib
import json
import plistlib
from pathlib import Path
import subprocess
import xml.etree.ElementTree as ET
from xml.sax.saxutils import escape

APP = "tech.dongdongbh.mindwtr.native.dev"
GROUP = "group." + APP
BASE = "MindwtrNative.xcodeproj"
DEFAULT_OUTPUT = "MindwtrNativeDev.generated.xcodeproj"
CLOUDKIT_OUTPUT = "MindwtrNativeDevCloudKit.generated.xcodeproj"
WATCH_OUTPUT = "MindwtrNativeDevWatch.generated.xcodeproj"
WATCH_CLOUDKIT_OUTPUT = "MindwtrNativeDevCloudKitWatch.generated.xcodeproj"
CLOUDKIT_CONTAINER = "iCloud." + APP
WATCH_ROOT = "../mobile/targets/watch"
WATCH_GROUP = GROUP + ".watch"
WATCH_ICON_SOURCE_SHA256 = "eea612902042cf79ebe1faf68fef668c9454a62400bd498273578e2cda9f953a"
SHARE_SOURCES = (
    "ShareExtension/ShareViewController.swift",
    "Sources/MindwtrNativeCore/NativeShareEnvelope.swift",
    "Sources/MindwtrNativeCore/NativeShareMailbox.swift",
    "Sources/MindwtrNativeCore/DurableFile.swift",
    "Sources/MindwtrNativeCore/HostFailure.swift",
)
WIDGET_SOURCES = (
    "CaptureWidget/NativeCaptureWidget.swift",
    "CaptureWidget/NativeCaptureWidgetIntent.swift",
    "CaptureWidget/NativeNextWidget.swift",
    "CaptureWidget/NativeWidgetActionIntents.swift",
    "Sources/MindwtrNativeCore/HostFailure.swift",
    "Sources/MindwtrNativeCore/NativeJSON.swift",
    "Sources/MindwtrNativeCore/NativeWidgetNextSnapshot.swift",
    "Sources/MindwtrNativeCore/NativeWidgetNextActionSnapshot.swift",
    "Sources/MindwtrNativeCore/NativeWidgetActionStore.swift",
    "Sources/MindwtrNativeCore/NativeWidgetNextCache.swift",
    "Sources/MindwtrNativeCore/NativeWidgetTaskLink.swift",
)


def require(condition, message):
    if not condition:
        raise ValueError(message)


def read_project(path):
    data = path.read_bytes()
    try:
        return plistlib.loads(data)
    except plistlib.InvalidFileException:
        converted = subprocess.run(
            ["/usr/bin/plutil", "-convert", "xml1", "-o", "-", "--", str(path)],
            check=True, capture_output=True,
        )
        return plistlib.loads(converted.stdout)


def asset_locales(native_root):
    """Read only maintained product files, including the exact existing dev claims."""
    required = (*SHARE_SOURCES, *WIDGET_SOURCES, "App/NativeCaptureIntents.swift",
                "ShareExtension/Info.plist", "CaptureWidget/Info.plist")
    for relative in required:
        require((native_root / relative).is_file(), "Missing maintained asset: " + relative)
    physical = {"com.apple.security.application-groups": [GROUP]}
    simulator_id = "MINDWTRSIM.$(PRODUCT_BUNDLE_IDENTIFIER)"
    claims = {
        "App/NativeShareDev.entitlements": physical,
        "ShareExtension/ShareExtension.entitlements": physical,
        "CaptureWidget/Widget.entitlements": physical,
        "CaptureWidget/Simulator.entitlements": {**physical, "application-identifier": simulator_id},
        "App/NativeShareDevSimulator.entitlements": {
            **physical, "application-identifier": simulator_id, "keychain-access-groups": [simulator_id]},
        "ShareExtension/Simulator.entitlements": {**physical, "application-identifier": simulator_id},
    }
    for relative, expected in claims.items():
        require(plistlib.loads((native_root / relative).read_bytes()) == expected,
                "Unexpected dev entitlement claims: " + relative)
    result = {}
    for directory, point in [("ShareExtension", "com.apple.share-services"),
                             ("CaptureWidget", "com.apple.widgetkit-extension")]:
        info = plistlib.loads((native_root / directory / "Info.plist").read_bytes())
        require(info["NSExtension"]["NSExtensionPointIdentifier"] == point, "Unexpected extension point")
        locales = sorted(path.parent.stem for path in (native_root / directory).glob("*.lproj/Localizable.strings"))
        require("en" in locales, "Missing English extension resources: " + directory)
        result[directory] = locales
    return result


def overlay(project, locales):
    """Pure graph overlay: input graph and all existing target IDs remain untouched."""
    value = copy.deepcopy(project)
    objects = value["objects"]
    root = objects[value["rootObject"]]
    targets = [(key, objects[key]) for key in root["targets"]]
    require(len(targets) == 2, "Expected the maintained App and UI-test targets only")
    app_id, app = next((key, item) for key, item in targets if item.get("name") == "MindwtrNative")
    _, tests = next((key, item) for key, item in targets if item.get("name") == "MindwtrNativeUITests")
    require(app["productType"] == "com.apple.product-type.application"
            and tests["productType"] == "com.apple.product-type.bundle.ui-testing", "Unexpected base target types")

    def configurations(target):
        return [objects[key] for key in objects[target["buildConfigurationList"]]["buildConfigurations"]]

    app_configs = configurations(app)
    require({item["name"] for item in app_configs} == {"Debug", "Release"}, "Expected App Debug/Release configurations")
    source_refs = [objects[build]["fileRef"] for phase in app["buildPhases"]
                   if objects[phase]["isa"] == "PBXSourcesBuildPhase" for build in objects[phase]["files"]]
    require(any(objects[key].get("path") == "NativeCaptureIntents.swift" for key in source_refs),
            "Register NativeCaptureIntents.swift in the maintained base App Sources first")
    for configuration in app_configs:
        settings = configuration["buildSettings"]
        require(settings.get("PRODUCT_BUNDLE_IDENTIFIER") == "tech.dongdongbh.mindwtr", "Unexpected base App identity")
        settings["PRODUCT_BUNDLE_IDENTIFIER"] = APP
        settings["MINDWTR_URL_SCHEME"] = "mindwtr-native-dev"
        settings["INFOPLIST_KEY_CFBundleDisplayName"] = "Mindwtr Native Dev"
        settings["CODE_SIGN_ENTITLEMENTS"] = "App/NativeShareDev.entitlements"
        settings["CODE_SIGN_ENTITLEMENTS[sdk=iphonesimulator*]"] = "App/NativeShareDevSimulator.entitlements"
        if configuration["name"] == "Debug":
            conditions = settings.get("SWIFT_ACTIVE_COMPILATION_CONDITIONS", [])
            conditions = conditions.split() if isinstance(conditions, str) else list(conditions)
            settings["SWIFT_ACTIVE_COMPILATION_CONDITIONS"] = list(dict.fromkeys(["$(inherited)", *conditions, "NATIVE_DEVICE_TEST"]))
    for configuration in configurations(tests):
        settings = configuration["buildSettings"]
        require(settings.get("PRODUCT_BUNDLE_IDENTIFIER") == "tech.dongdongbh.mindwtr.uitests", "Unexpected base UI-test identity")
        settings["PRODUCT_BUNDLE_IDENTIFIER"] = APP + ".uitests"

    def add(label, item):
        identifier = hashlib.sha256(("mindwtr-native-dev:" + label).encode()).hexdigest()[:24].upper()
        require(identifier not in objects, "Generated object already exists: " + label)
        objects[identifier] = item
        return identifier

    def phase(label, kind, files):
        return add(label, {"isa": "PBX" + kind + "BuildPhase", "buildActionMask": 2147483647,
                           "files": files, "runOnlyForDeploymentPostprocessing": 0})

    embeds = []
    for directory, name, suffix, sources, deployment in [
        ("ShareExtension", "MindwtrNativeShare", ".share", SHARE_SOURCES, "16.0"),
        ("CaptureWidget", "MindwtrNativeCaptureWidget", ".capture-widget", WIDGET_SOURCES, "17.0"),
    ]:
        children, builds = [], []
        for path in sources:
            ref = add(name + ":file:" + path, {"isa": "PBXFileReference", "lastKnownFileType": "sourcecode.swift",
                                                "path": path, "sourceTree": "SOURCE_ROOT"})
            children.append(ref)
            builds.append(add(name + ":source:" + path, {"isa": "PBXBuildFile", "fileRef": ref}))
        translations = []
        for language in locales[directory]:
            translations.append(add(name + ":locale:" + language, {"isa": "PBXFileReference", "name": language,
                "lastKnownFileType": "text.plist.strings", "path": directory + "/" + language + ".lproj/Localizable.strings",
                "sourceTree": "SOURCE_ROOT"}))
        strings = add(name + ":strings", {"isa": "PBXVariantGroup", "children": translations,
                                         "name": "Localizable.strings", "sourceTree": "<group>"})
        children.append(strings)
        strings_build = add(name + ":strings-build", {"isa": "PBXBuildFile", "fileRef": strings})
        group = add(name + ":group", {"isa": "PBXGroup", "children": children, "name": directory, "sourceTree": "<group>"})
        objects[root["mainGroup"]]["children"].append(group)
        product = add(name + ":product", {"isa": "PBXFileReference", "explicitFileType": "wrapper.app-extension",
            "includeInIndex": 0, "path": name + ".appex", "sourceTree": "BUILT_PRODUCTS_DIR"})
        objects[root["productRefGroup"]]["children"].append(product)
        configs = []
        for original in app_configs:
            settings = {
                "APPLICATION_EXTENSION_API_ONLY": "YES", "SKIP_INSTALL": "YES", "PRODUCT_BUNDLE_IDENTIFIER": APP + suffix,
                "PRODUCT_NAME": name, "SWIFT_VERSION": "5.0", "IPHONEOS_DEPLOYMENT_TARGET": deployment,
                "SUPPORTED_PLATFORMS": "iphoneos iphonesimulator", "TARGETED_DEVICE_FAMILY": "1,2", "SUPPORTS_MACCATALYST": "NO",
                "GENERATE_INFOPLIST_FILE": "NO", "INFOPLIST_FILE": directory + "/Info.plist",
                "CODE_SIGNING_ALLOWED[sdk=iphonesimulator*]": "YES", "CODE_SIGN_IDENTITY[sdk=iphonesimulator*]": "-",
                "LD_RUNPATH_SEARCH_PATHS": ["$(inherited)", "@executable_path/Frameworks", "@executable_path/../../Frameworks"],
            }
            for key in ["MARKETING_VERSION", "CURRENT_PROJECT_VERSION"]:
                if key in original["buildSettings"]:
                    settings[key] = original["buildSettings"][key]
            if directory == "ShareExtension":
                settings.update({"SWIFT_ACTIVE_COMPILATION_CONDITIONS": "$(inherited) MINDWTR_SHARE_EXTENSION",
                    "CODE_SIGN_ENTITLEMENTS": "ShareExtension/ShareExtension.entitlements",
                    "CODE_SIGN_ENTITLEMENTS[sdk=iphonesimulator*]": "ShareExtension/Simulator.entitlements"})
            else:
                settings.update({"SWIFT_ACTIVE_COMPILATION_CONDITIONS": "$(inherited) MINDWTR_WIDGET_EXTENSION",
                    "CODE_SIGN_ENTITLEMENTS": "CaptureWidget/Widget.entitlements",
                    "CODE_SIGN_ENTITLEMENTS[sdk=iphonesimulator*]": "CaptureWidget/Simulator.entitlements"})
            configs.append(add(name + ":config:" + original["name"],
                               {"isa": "XCBuildConfiguration", "name": original["name"], "buildSettings": settings}))
        config_list = add(name + ":configs", {"isa": "XCConfigurationList", "buildConfigurations": configs,
                                             "defaultConfigurationIsVisible": 0, "defaultConfigurationName": "Debug"})
        target = add(name + ":target", {"isa": "PBXNativeTarget", "buildConfigurationList": config_list,
            "buildPhases": [phase(name + ":sources", "Sources", builds), phase(name + ":frameworks", "Frameworks", []),
                            phase(name + ":resources", "Resources", [strings_build])],
            "buildRules": [], "dependencies": [], "packageProductDependencies": [], "name": name,
            "productName": name, "productReference": product, "productType": "com.apple.product-type.app-extension"})
        root["targets"].append(target)
        proxy = add(name + ":proxy", {"isa": "PBXContainerItemProxy", "containerPortal": value["rootObject"],
            "proxyType": 1, "remoteGlobalIDString": target, "remoteInfo": name})
        app["dependencies"].append(add(name + ":dependency", {"isa": "PBXTargetDependency", "target": target, "targetProxy": proxy}))
        embeds.append(add(name + ":embed", {"isa": "PBXBuildFile", "fileRef": product,
            "settings": {"ATTRIBUTES": ["CodeSignOnCopy", "RemoveHeadersOnCopy"]}}))
        if directory in ["ShareExtension", "CaptureWidget"]:
            attributes = root.setdefault("attributes", {}).setdefault("TargetAttributes", {})
            for identifier in [app_id, target]:
                attributes.setdefault(identifier, {}).setdefault("SystemCapabilities", {})["com.apple.ApplicationGroups.iOS"] = {"enabled": 1}
    embed = phase("embed-extensions", "CopyFiles", embeds)
    objects[embed].update({"name": "Embed App Extensions", "dstPath": "", "dstSubfolderSpec": 13})
    app["buildPhases"].append(embed)
    root["knownRegions"] = list(dict.fromkeys([*root.get("knownRegions", []), *locales["ShareExtension"], *locales["CaptureWidget"]]))
    return value


def watch_overlay(project, native_root, output, generated_files):
    """Mirror the maintained RN Watch packaging without touching its sources."""
    source_root = native_root / WATCH_ROOT
    resources = source_root / "Resources"
    shared = sorted((source_root / "Shared").glob("*.swift"))
    require(shared, "Missing maintained Watch Shared sources")
    info = plistlib.loads((resources / "Watch-Info.plist").read_bytes())
    require(info.get("WKApplication") is True
            and info.get("WKCompanionAppBundleIdentifier") == "$(MINDWTR_HOST_BUNDLE_IDENTIFIER)",
            "Unexpected maintained Watch application Info")
    widget_info = plistlib.loads((resources / "Widgets-Info.plist").read_bytes())
    require(widget_info["NSExtension"]["NSExtensionPointIdentifier"] == "com.apple.widgetkit-extension",
            "Unexpected maintained Watch widget Info")
    for name in ["Watch", "Widgets"]:
        require(plistlib.loads((resources / (name + ".entitlements")).read_bytes()) == {
            "com.apple.security.application-groups": ["$(MINDWTR_WATCH_APP_GROUP)"]},
            "Unexpected maintained Watch entitlement claims")
    icon_contents = (resources / "AppIcon.appiconset/Contents.json").read_bytes()
    require(json.loads(icon_contents)["images"] == [{"filename": "AppIcon.png", "idiom": "universal",
            "platform": "watchos", "size": "1024x1024"}], "Unexpected maintained Watch icon catalog")
    require(hashlib.sha256((native_root / "../mobile/assets/images/icon.png").read_bytes()).hexdigest()
            == WATCH_ICON_SOURCE_SHA256, "Watch icon source changed; regenerate scripts/create-dev-project-assets/WatchAppIcon.png")
    generated_files["Watch/Assets.xcassets/Contents.json"] = b'{"info":{"author":"xcode","version":1}}\n'
    generated_files["Watch/Assets.xcassets/AppIcon.appiconset/Contents.json"] = icon_contents
    # magick apps/mobile/assets/images/icon.png -background white -alpha remove -alpha off PNG24:<WatchAppIcon.png>
    generated_files["Watch/Assets.xcassets/AppIcon.appiconset/AppIcon.png"] = (
        Path(__file__).parent / "create-dev-project-assets/WatchAppIcon.png").read_bytes()
    objects = project["objects"]
    root = objects[project["rootObject"]]
    app_id, app = next((key, item) for key, item in objects.items()
                       if item.get("isa") == "PBXNativeTarget" and item.get("name") == "MindwtrNative")
    app_configs = [objects[key] for key in objects[app["buildConfigurationList"]]["buildConfigurations"]]

    def add(label, item):
        identifier = hashlib.sha256(("mindwtr-native-dev-watch:" + label).encode()).hexdigest()[:24].upper()
        require(identifier not in objects, "Generated Watch object already exists: " + label)
        objects[identifier] = item
        return identifier

    def phase(label, kind, files):
        return add(label, {"isa": "PBX" + kind + "BuildPhase", "buildActionMask": 2147483647,
                           "files": files, "runOnlyForDeploymentPostprocessing": 0})

    targets = []
    for directory, name, suffix, widget in [
        ("App", "MindwtrWatch", ".watchkitapp", False),
        ("Widgets", "MindwtrWatchWidgets", ".watchkitapp.widgets", True),
    ]:
        sources = sorted((source_root / directory).glob("*.swift"))
        require(sources, "Missing maintained Watch sources: " + directory)
        files = [(WATCH_ROOT + "/" + str(path.relative_to(source_root)), "sourcecode.swift", "Sources")
                 for path in [*sources, *shared]]
        for resource, kind in [("Localizable.xcstrings", "text.json.xcstrings"),
                               ("PrivacyInfo.xcprivacy", "text.xml")]:
            require((resources / resource).is_file(), "Missing maintained Watch resource: " + resource)
            files.append((WATCH_ROOT + "/Resources/" + resource, kind, "Resources"))
        if not widget:
            files.append((output.name + "/Watch/Assets.xcassets", "folder.assetcatalog", "Resources"))
        children, builds = [], {"Sources": [], "Resources": []}
        for path, kind, build_phase in files:
            ref = add(name + ":file:" + path, {"isa": "PBXFileReference", "lastKnownFileType": kind,
                                               "path": path, "sourceTree": "SOURCE_ROOT"})
            children.append(ref)
            builds[build_phase].append(add(name + ":build:" + path, {"isa": "PBXBuildFile", "fileRef": ref}))
        objects[root["mainGroup"]]["children"].append(add(name + ":group", {
            "isa": "PBXGroup", "children": children, "name": name, "sourceTree": "<group>"}))
        product = add(name + ":product", {"isa": "PBXFileReference", "explicitFileType":
            "wrapper.app-extension" if widget else "wrapper.application", "includeInIndex": 0,
            "path": name + (".appex" if widget else ".app"), "sourceTree": "BUILT_PRODUCTS_DIR"})
        objects[root["productRefGroup"]]["children"].append(product)
        configs = []
        for original in app_configs:
            settings = {"ALWAYS_EMBED_SWIFT_STANDARD_LIBRARIES": "YES", "SKIP_INSTALL": "YES",
                "PRODUCT_BUNDLE_IDENTIFIER": APP + suffix, "PRODUCT_NAME": name, "SWIFT_VERSION": "5.0",
                "SDKROOT": "watchos", "WATCHOS_DEPLOYMENT_TARGET": "10.0",
                "SUPPORTED_PLATFORMS": "watchos watchsimulator", "TARGETED_DEVICE_FAMILY": "4",
                "GENERATE_INFOPLIST_FILE": "NO", "SWIFT_EMIT_LOC_STRINGS": "YES",
                "INFOPLIST_FILE": WATCH_ROOT + "/Resources/" + ("Widgets" if widget else "Watch") + "-Info.plist",
                "CODE_SIGN_ENTITLEMENTS": WATCH_ROOT + "/Resources/" + ("Widgets" if widget else "Watch") + ".entitlements",
                "MINDWTR_SPOKEN_NAME": "Mind Water Dev", "MINDWTR_HOST_BUNDLE_IDENTIFIER": APP,
                "MINDWTR_WATCH_APP_GROUP": WATCH_GROUP,
                "LD_RUNPATH_SEARCH_PATHS": ["$(inherited)", "@executable_path/Frameworks"],
                "ASSETCATALOG_COMPILER_APPICON_NAME": "" if widget else "AppIcon"}
            for key in ["MARKETING_VERSION", "CURRENT_PROJECT_VERSION"]:
                if key in original["buildSettings"]:
                    settings[key] = original["buildSettings"][key]
            if widget:
                settings["APPLICATION_EXTENSION_API_ONLY"] = "YES"
            if original["name"] == "Debug":
                settings["SWIFT_OPTIMIZATION_LEVEL"] = "-Onone"
            configs.append(add(name + ":config:" + original["name"], {
                "isa": "XCBuildConfiguration", "name": original["name"], "buildSettings": settings}))
        config_list = add(name + ":configs", {"isa": "XCConfigurationList", "buildConfigurations": configs,
            "defaultConfigurationIsVisible": 0, "defaultConfigurationName": "Debug"})
        target = add(name + ":target", {"isa": "PBXNativeTarget", "buildConfigurationList": config_list,
            "buildPhases": [phase(name + ":sources", "Sources", builds["Sources"]),
                            phase(name + ":frameworks", "Frameworks", []),
                            phase(name + ":resources", "Resources", builds["Resources"])],
            "buildRules": [], "dependencies": [], "packageProductDependencies": [], "name": name,
            "productName": name, "productReference": product,
            "productType": "com.apple.product-type.app-extension" if widget else "com.apple.product-type.application"})
        root["targets"].append(target)
        root.setdefault("attributes", {}).setdefault("TargetAttributes", {})[target] = {
            "SystemCapabilities": {"com.apple.ApplicationGroups.iOS": {"enabled": 1}}}
        targets.append((target, product, name))
    for parent, (target, product, name), label, destination, subfolder in [
        (app, targets[0], "Embed Watch Content", "$(CONTENTS_FOLDER_PATH)/Watch", 16),
        (objects[targets[0][0]], targets[1], "Embed Watch Extensions", "", 13),
    ]:
        proxy = add(name + ":proxy", {"isa": "PBXContainerItemProxy", "containerPortal": project["rootObject"],
            "proxyType": 1, "remoteGlobalIDString": target, "remoteInfo": name})
        parent["dependencies"].append(add(name + ":dependency", {
            "isa": "PBXTargetDependency", "target": target, "targetProxy": proxy}))
        build = add(name + ":embed", {"isa": "PBXBuildFile", "fileRef": product,
            "settings": {"ATTRIBUTES": ["CodeSignOnCopy", "RemoveHeadersOnCopy"]}})
        embed = phase(name + ":embed-phase", "CopyFiles", [build])
        objects[embed].update({"name": label, "dstPath": destination, "dstSubfolderSpec": subfolder})
        parent["buildPhases"].append(embed)
    catalog = json.loads((resources / "Localizable.xcstrings").read_bytes())
    languages = sorted({language for item in catalog["strings"].values() for language in item.get("localizations", {})})
    root["knownRegions"] = list(dict.fromkeys([*root.get("knownRegions", []), *languages]))


def generate(native_root, output, *, cloudkit=False, watch=False, dropbox_app_key=None, dropbox_redirect_uri=None):
    native_root = native_root.resolve(strict=True)
    output = output.absolute()
    require(output.suffix == ".xcodeproj" and output.parent.resolve() == native_root, "Output must be a sibling .xcodeproj")
    if output.exists() or output.is_symlink():
        raise FileExistsError("Output already exists; it is preserved: " + str(output))
    dropbox = dropbox_app_key is not None or dropbox_redirect_uri is not None
    if dropbox:
        require(isinstance(dropbox_app_key, str) and 0 < len(dropbox_app_key) <= 512
                and dropbox_app_key.isascii() and dropbox_app_key.isalnum(), "Invalid public Dropbox app key")
        require(dropbox_redirect_uri == "mindwtr-native-dev://redirect",
                "Dropbox dev redirect must use the existing mindwtr-native-dev scheme")
    base = native_root / BASE / "project.pbxproj"
    original = base.read_bytes()
    project = overlay(read_project(base), asset_locales(native_root))
    generated_files = {}
    if cloudkit:
        info = plistlib.loads((native_root / "App/Info.plist").read_bytes())
        require(isinstance(info, dict), "App Info must be a dictionary")
        info["NativeCloudKitContainer"] = CLOUDKIT_CONTAINER
        generated_files["CloudKit/Info.plist"] = plistlib.dumps(info, sort_keys=False)
        claims = {"com.apple.developer.icloud-container-identifiers": [CLOUDKIT_CONTAINER],
                  "com.apple.developer.icloud-services": ["CloudKit"],
                  "com.apple.developer.icloud-container-environment": "Development"}
        for name, source in [("App.entitlements", "NativeShareDev.entitlements"),
                             ("Simulator.entitlements", "NativeShareDevSimulator.entitlements")]:
            entitlements = plistlib.loads((native_root / "App" / source).read_bytes())
            generated_files["CloudKit/" + name] = plistlib.dumps({**entitlements, **claims}, sort_keys=False)
        objects = project["objects"]
        app_id, app = next((key, item) for key, item in objects.items()
                           if item.get("isa") == "PBXNativeTarget" and item.get("name") == "MindwtrNative")
        for configuration in objects[app["buildConfigurationList"]]["buildConfigurations"]:
            settings = objects[configuration]["buildSettings"]
            settings["INFOPLIST_FILE"] = output.name + "/CloudKit/Info.plist"
            settings["CODE_SIGN_ENTITLEMENTS"] = output.name + "/CloudKit/App.entitlements"
            settings["CODE_SIGN_ENTITLEMENTS[sdk=iphonesimulator*]"] = output.name + "/CloudKit/Simulator.entitlements"
        attributes = objects[project["rootObject"]].setdefault("attributes", {}).setdefault("TargetAttributes", {})
        attributes[app_id].setdefault("SystemCapabilities", {})["com.apple.iCloud"] = {"enabled": 1}
    if watch:
        watch_overlay(project, native_root, output, generated_files)
        info_path = "CloudKit/Info.plist" if cloudkit else "Watch/Info.plist"
        info = plistlib.loads(generated_files[info_path] if cloudkit else (native_root / "App/Info.plist").read_bytes())
        info["MindwtrWatchEnabled"] = True
        generated_files[info_path] = plistlib.dumps(info, sort_keys=False)
        objects = project["objects"]
        app = next(item for item in objects.values()
                   if item.get("isa") == "PBXNativeTarget" and item.get("name") == "MindwtrNative")
        for configuration in objects[app["buildConfigurationList"]]["buildConfigurations"]:
            objects[configuration]["buildSettings"]["INFOPLIST_FILE"] = output.name + "/" + info_path
    if dropbox:
        info_path = "CloudKit/Info.plist" if cloudkit else "Watch/Info.plist" if watch else "Dropbox/Info.plist"
        info = plistlib.loads(generated_files[info_path] if info_path in generated_files
                             else (native_root / "App/Info.plist").read_bytes())
        schemes = ["mindwtr-native-dev" if scheme == "$(MINDWTR_URL_SCHEME)" else scheme
                   for item in info.get("CFBundleURLTypes", []) for scheme in item.get("CFBundleURLSchemes", [])]
        require("mindwtr-native-dev" in schemes, "Existing dev callback scheme is missing")
        info.update(MindwtrDropboxAppKey=dropbox_app_key, MindwtrDropboxRedirectURI=dropbox_redirect_uri)
        generated_files[info_path] = plistlib.dumps(info, sort_keys=False)
        objects = project["objects"]
        app = next(item for item in objects.values()
                   if item.get("isa") == "PBXNativeTarget" and item.get("name") == "MindwtrNative")
        for configuration in objects[app["buildConfigurationList"]]["buildConfigurations"]:
            objects[configuration]["buildSettings"]["INFOPLIST_FILE"] = output.name + "/" + info_path
    scheme = native_root / BASE / "xcshareddata/xcschemes/MindwtrNative.xcscheme"
    scheme_bytes = scheme.read_bytes()
    parsed = ET.fromstring(scheme_bytes)
    references = list(parsed.iter("BuildableReference"))
    require(references and all(ref.get("ReferencedContainer") == "container:" + BASE for ref in references),
            "Unexpected shared scheme container")
    container = escape("container:" + output.name, {'"': "&quot;", "'": "&apos;"})
    rewritten = scheme_bytes.decode("utf-8").replace("container:" + BASE, container).encode("utf-8")
    require([ref.get("BlueprintIdentifier") for ref in ET.fromstring(rewritten).iter("BuildableReference")]
            == [ref.get("BlueprintIdentifier") for ref in references], "Scheme target identities changed")
    encoded = plistlib.dumps(project, sort_keys=False)
    require(base.read_bytes() == original, "Base project changed while generating; no output written")
    output.mkdir()  # Freshness is checked atomically; never replace any existing output.
    (output / ".gitignore").write_text("*\n")
    (output / "project.pbxproj").write_bytes(encoded)
    for relative, data in generated_files.items():
        target = output / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    schemes = output / "xcshareddata/xcschemes"
    schemes.mkdir(parents=True)
    (schemes / "MindwtrNative.xcscheme").write_bytes(rewritten)
    return output


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-project", type=Path, help="fresh sibling .xcodeproj; otherwise use a separate default for each --cloudkit/--watch variant")
    parser.add_argument("--cloudkit", action="store_true", help="opt in to the isolated native.dev CloudKit Development container")
    parser.add_argument("--watch", action="store_true", help="opt in to the maintained Watch companion in a separate generated project")
    parser.add_argument("--dropbox-app-key", help="explicit public Dropbox app key; requires redirect URI")
    parser.add_argument("--dropbox-redirect-uri", help="registered dev callback URI; does not register it with Dropbox")
    args = parser.parse_args()
    native_root = Path(__file__).resolve().parents[1]
    default_output = (WATCH_CLOUDKIT_OUTPUT if args.cloudkit else WATCH_OUTPUT) if args.watch else (CLOUDKIT_OUTPUT if args.cloudkit else DEFAULT_OUTPUT)
    output = args.output_project or native_root / default_output
    try:
        print(generate(native_root, output, cloudkit=args.cloudkit, watch=args.watch,
                       dropbox_app_key=args.dropbox_app_key, dropbox_redirect_uri=args.dropbox_redirect_uri))
    except (OSError, ValueError, KeyError, StopIteration, subprocess.CalledProcessError) as error:
        parser.exit(1, "Dev project generation failed: " + str(error) + "\n")


if __name__ == "__main__":
    main()
