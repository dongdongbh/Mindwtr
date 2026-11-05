#!/usr/bin/env python3
import copy
import importlib.util
import plistlib
from pathlib import Path
import shutil
import struct
import sys
import tempfile
import unittest
from unittest.mock import patch
import xml.etree.ElementTree as ET

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("create_dev_project", HERE / "create-dev-project.py")
generator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(generator)


def base_project():
    objects = {
        "project": {"isa": "PBXProject", "targets": ["app", "tests"], "mainGroup": "main", "productRefGroup": "products",
                    "knownRegions": ["en", "Base"], "packageReferences": ["package"], "buildConfigurationList": "project-configs"},
        "main": {"isa": "PBXGroup", "children": ["intent", "products"]},
        "products": {"isa": "PBXGroup", "children": []},
        "package": {"isa": "XCLocalSwiftPackageReference", "relativePath": "."},
        "intent": {"isa": "PBXFileReference", "path": "NativeCaptureIntents.swift", "sourceTree": "<group>"},
        "intent-build": {"isa": "PBXBuildFile", "fileRef": "intent"},
        "app-sources": {"isa": "PBXSourcesBuildPhase", "files": ["intent-build"]},
        "app": {"isa": "PBXNativeTarget", "name": "MindwtrNative", "productType": "com.apple.product-type.application",
                "buildConfigurationList": "app-configs", "buildPhases": ["app-sources"], "dependencies": []},
        "tests": {"isa": "PBXNativeTarget", "name": "MindwtrNativeUITests", "productType": "com.apple.product-type.bundle.ui-testing",
                  "buildConfigurationList": "test-configs", "buildPhases": [], "dependencies": ["test-app-dependency"]},
        "test-app-dependency": {"isa": "PBXTargetDependency", "target": "app"},
    }
    for scope in ["app", "test", "project"]:
        configs = []
        for name in ["Debug", "Release"]:
            identifier = scope + "-" + name
            if scope == "project":
                settings = {"CODE_SIGNING_ALLOWED": "NO", "SWIFT_ACTIVE_COMPILATION_CONDITIONS": "DEBUG" if name == "Debug" else ""}
            else:
                settings = {"PRODUCT_BUNDLE_IDENTIFIER": "tech.dongdongbh.mindwtr" + (".uitests" if scope == "test" else "")}
                if scope == "app":
                    settings.update(MARKETING_VERSION="1.3.3", CURRENT_PROJECT_VERSION="42")
                    settings["MINDWTR_URL_SCHEME"] = "mindwtr"
                    if name == "Debug":
                        settings.update({"CODE_SIGNING_ALLOWED[sdk=iphonesimulator*]": "YES", "CODE_SIGN_IDENTITY[sdk=iphonesimulator*]": "-",
                                         "SWIFT_ACTIVE_COMPILATION_CONDITIONS": ["$(inherited)", "KEEP_ME"]})
            objects[identifier] = {"isa": "XCBuildConfiguration", "name": name, "buildSettings": settings}
            configs.append(identifier)
        objects[scope + "-configs"] = {"isa": "XCConfigurationList", "buildConfigurations": configs}
    return {"archiveVersion": "1", "objectVersion": "54", "objects": objects, "rootObject": "project"}


class DevProjectTests(unittest.TestCase):
    def test_production_scheme_is_not_registered_by_the_dev_overlay(self):
        original = base_project()
        result = generator.overlay(original, generator.asset_locales(HERE.parent))
        info = plistlib.loads((HERE.parent / "App/Info.plist").read_bytes())
        self.assertEqual(info["CFBundleURLTypes"][0]["CFBundleURLSchemes"], ["$(MINDWTR_URL_SCHEME)"])
        for name in ["Debug", "Release"]:
            self.assertEqual(original["objects"]["app-" + name]["buildSettings"]["MINDWTR_URL_SCHEME"], "mindwtr")
            self.assertEqual(result["objects"]["app-" + name]["buildSettings"]["MINDWTR_URL_SCHEME"], "mindwtr-native-dev")

    def test_overlay_preserves_base_and_builds_exact_dev_targets_and_membership(self):
        original = base_project()
        saved = copy.deepcopy(original)
        locales = generator.asset_locales(HERE.parent)
        result = generator.overlay(original, locales)
        self.assertEqual(original, saved)
        self.assertEqual(result, generator.overlay(original, locales))
        missing_intent = copy.deepcopy(original)
        missing_intent["objects"]["app-sources"]["files"] = []
        with self.assertRaisesRegex(ValueError, "Register NativeCaptureIntents"):
            generator.overlay(missing_intent, locales)
        objects = result["objects"]
        self.assertEqual(objects["package"], saved["objects"]["package"])
        self.assertEqual(objects["project-Debug"], saved["objects"]["project-Debug"])
        self.assertEqual(objects["app-sources"], saved["objects"]["app-sources"])
        self.assertEqual(objects["tests"]["dependencies"], ["test-app-dependency"])
        self.assertEqual(objects["app-Debug"]["buildSettings"]["SWIFT_ACTIVE_COMPILATION_CONDITIONS"],
                         ["$(inherited)", "KEEP_ME", "NATIVE_DEVICE_TEST"])
        targets = {item["name"]: (key, item) for key, item in objects.items() if item.get("isa") == "PBXNativeTarget"}
        self.assertEqual(set(targets), {"MindwtrNative", "MindwtrNativeUITests", "MindwtrNativeShare", "MindwtrNativeCaptureWidget"})
        self.assertEqual(targets["MindwtrNative"][0], "app")
        for name, suffix, expected_sources, directory in [
            ("MindwtrNativeShare", ".share", generator.SHARE_SOURCES, "ShareExtension"),
            ("MindwtrNativeCaptureWidget", ".capture-widget", generator.WIDGET_SOURCES, "CaptureWidget"),
        ]:
            identifier, target = targets[name]
            paths = [objects[objects[build]["fileRef"]]["path"] for phase in target["buildPhases"]
                     if objects[phase]["isa"] == "PBXSourcesBuildPhase" for build in objects[phase]["files"]]
            self.assertEqual(paths, list(expected_sources))
            self.assertEqual(target["packageProductDependencies"], [])
            resources = [objects[objects[build]["fileRef"]] for phase in target["buildPhases"]
                         if objects[phase]["isa"] == "PBXResourcesBuildPhase" for build in objects[phase]["files"]]
            self.assertEqual({objects[child]["name"] for child in resources[0]["children"]}, set(locales[directory]))
            for config in objects[target["buildConfigurationList"]]["buildConfigurations"]:
                settings = objects[config]["buildSettings"]
                self.assertEqual(settings["PRODUCT_BUNDLE_IDENTIFIER"], generator.APP + suffix)
                self.assertEqual(settings["CURRENT_PROJECT_VERSION"], "42")
                self.assertEqual(settings["MARKETING_VERSION"], "1.3.3")
                self.assertFalse(any(key in settings for key in ["DEVELOPMENT_TEAM", "PROVISIONING_PROFILE_SPECIFIER"]))
                if directory == "CaptureWidget":
                    self.assertEqual(settings["CODE_SIGN_ENTITLEMENTS"], "CaptureWidget/Widget.entitlements")
                    self.assertEqual(settings["CODE_SIGN_ENTITLEMENTS[sdk=iphonesimulator*]"], "CaptureWidget/Simulator.entitlements")
                    self.assertEqual(settings["SWIFT_ACTIVE_COMPILATION_CONDITIONS"], "$(inherited) MINDWTR_WIDGET_EXTENSION")
                    self.assertNotIn("Sources/MindwtrNativeCore/CoreHost.swift", paths)
                    self.assertNotIn("Sources/MindwtrNativeCore/DurableFile.swift", paths)
                    self.assertTrue({"CaptureWidget/NativeWidgetActionIntents.swift",
                                     "Sources/MindwtrNativeCore/NativeWidgetNextActionSnapshot.swift",
                                     "Sources/MindwtrNativeCore/NativeWidgetActionStore.swift"}.issubset(paths))
                    self.assertFalse(any("SQLite" in path or "JavaScriptCore" in path for path in paths))
                    self.assertEqual(objects["project"]["attributes"]["TargetAttributes"][identifier]["SystemCapabilities"],
                                     {"com.apple.ApplicationGroups.iOS": {"enabled": 1}})
                else:
                    self.assertEqual(settings["CODE_SIGN_ENTITLEMENTS"], "ShareExtension/ShareExtension.entitlements")
            self.assertIn(identifier, [objects[dependency]["target"] for dependency in objects["app"]["dependencies"]])
        self.assertEqual(objects["app-Debug"]["buildSettings"]["PRODUCT_BUNDLE_IDENTIFIER"], generator.APP)
        self.assertEqual(objects["test-Debug"]["buildSettings"]["PRODUCT_BUNDLE_IDENTIFIER"], generator.APP + ".uitests")
        self.assertEqual(objects["app-Debug"]["buildSettings"]["CODE_SIGN_ENTITLEMENTS"], "App/NativeShareDev.entitlements")
        embed = next(objects[key] for key in objects["app"]["buildPhases"] if objects[key]["isa"] == "PBXCopyFilesBuildPhase")
        self.assertEqual(embed["dstSubfolderSpec"], 13)
        self.assertEqual(len(embed["files"]), 2)
        self.assertTrue(all(objects[key]["settings"]["ATTRIBUTES"] == ["CodeSignOnCopy", "RemoveHeadersOnCopy"] for key in embed["files"]))
        for item in objects.values():
            if item.get("isa") == "PBXFileReference" and item.get("sourceTree") == "SOURCE_ROOT":
                self.assertFalse(Path(item["path"]).is_absolute())

    def test_fresh_generation_preserves_input_scheme_and_refuses_existing_or_foreign_output(self):
        scratch = HERE.parent / ".build"
        scratch.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="dev-project-test-", dir=scratch) as directory:
            native = Path(directory)
            for name in [*generator.SHARE_SOURCES, *generator.WIDGET_SOURCES, "App/NativeCaptureIntents.swift",
                         "App/NativeShareDev.entitlements", "App/NativeShareDevSimulator.entitlements"]:
                target = native / name
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(HERE.parent / name, target)
            for name in ["ShareExtension", "CaptureWidget"]:
                shutil.copytree(HERE.parent / name, native / name, dirs_exist_ok=True)
            # A newly maintained locale is discovered, not hardcoded by the overlay.
            extra = native / "CaptureWidget/xx.lproj/Localizable.strings"
            extra.parent.mkdir(); extra.write_text('"Add Task" = "Example";\n')
            project = native / generator.BASE
            scheme = project / "xcshareddata/xcschemes/MindwtrNative.xcscheme"
            scheme.parent.mkdir(parents=True)
            scheme.write_text('<Scheme><!-- keep --><BuildableReference BlueprintIdentifier="app" ReferencedContainer="container:MindwtrNative.xcodeproj"/></Scheme>')
            base = project / "project.pbxproj"
            base.write_bytes(plistlib.dumps(base_project()))
            original, original_scheme = base.read_bytes(), scheme.read_bytes()
            output = native / generator.DEFAULT_OUTPUT
            generator.generate(native, output)
            self.assertEqual(base.read_bytes(), original)
            self.assertEqual(scheme.read_bytes(), original_scheme)
            encoded = (output / "project.pbxproj").read_bytes()
            self.assertNotIn(str(native).encode(), encoded)
            self.assertNotIn(b".orchestrator", encoded)
            self.assertIn("xx", plistlib.loads(encoded)["objects"]["project"]["knownRegions"])
            rewritten = (output / "xcshareddata/xcschemes/MindwtrNative.xcscheme").read_bytes()
            self.assertIn(b"<!-- keep -->", rewritten)
            reference = ET.fromstring(rewritten).find("BuildableReference")
            self.assertEqual(reference.get("BlueprintIdentifier"), "app")
            self.assertEqual(reference.get("ReferencedContainer"), "container:" + generator.DEFAULT_OUTPUT)
            self.assertEqual((output / ".gitignore").read_text(), "*\n")
            with self.assertRaises(FileExistsError):
                generator.generate(native, output)
            self.assertEqual((output / "project.pbxproj").read_bytes(), encoded)
            foreign = native.parent / (native.name + ".outside.xcodeproj")
            with self.assertRaises(ValueError):
                generator.generate(native, foreign)
            self.assertFalse(foreign.exists())

    def test_cloudkit_flag_isolates_generated_claims_info_and_app_settings(self):
        scratch = HERE.parent / ".build"
        scratch.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="dev-cloudkit-project-test-", dir=scratch) as directory:
            native = Path(directory)
            for name in [*generator.SHARE_SOURCES, *generator.WIDGET_SOURCES, "App/NativeCaptureIntents.swift",
                         "App/Info.plist", "App/NativeShareDev.entitlements", "App/NativeShareDevSimulator.entitlements"]:
                target = native / name
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(HERE.parent / name, target)
            for name in ["ShareExtension", "CaptureWidget"]:
                shutil.copytree(HERE.parent / name, native / name, dirs_exist_ok=True)
            project = native / generator.BASE
            scheme = project / "xcshareddata/xcschemes/MindwtrNative.xcscheme"
            scheme.parent.mkdir(parents=True)
            scheme.write_text('<Scheme><!-- retained --><BuildableReference BlueprintIdentifier="app" ReferencedContainer="container:MindwtrNative.xcodeproj"/></Scheme>')
            (project / "project.pbxproj").write_bytes(plistlib.dumps(base_project()))
            originals = {path.relative_to(native): path.read_bytes() for path in native.rglob("*") if path.is_file()}
            normal = generator.generate(native, native / generator.DEFAULT_OUTPUT)
            normal_files = {path.relative_to(normal): path.read_bytes() for path in normal.rglob("*") if path.is_file()}
            output = generator.generate(native, native / generator.CLOUDKIT_OUTPUT, cloudkit=True)
            self.assertNotEqual(normal, output)
            self.assertEqual({path.relative_to(normal): path.read_bytes() for path in normal.rglob("*") if path.is_file()}, normal_files)
            for relative, encoded in originals.items():
                self.assertEqual((native / relative).read_bytes(), encoded, str(relative))
            expected = plistlib.loads(normal_files[Path("project.pbxproj")])
            objects = expected["objects"]
            for name in ["Debug", "Release"]:
                settings = objects["app-" + name]["buildSettings"]
                settings["INFOPLIST_FILE"] = output.name + "/CloudKit/Info.plist"
                settings["CODE_SIGN_ENTITLEMENTS"] = output.name + "/CloudKit/App.entitlements"
                settings["CODE_SIGN_ENTITLEMENTS[sdk=iphonesimulator*]"] = output.name + "/CloudKit/Simulator.entitlements"
                for key in ["INFOPLIST_FILE", "CODE_SIGN_ENTITLEMENTS", "CODE_SIGN_ENTITLEMENTS[sdk=iphonesimulator*]"]:
                    self.assertEqual((native / settings[key]).parent, output / "CloudKit")
            objects["project"]["attributes"]["TargetAttributes"]["app"]["SystemCapabilities"]["com.apple.iCloud"] = {"enabled": 1}
            self.assertEqual(plistlib.loads((output / "project.pbxproj").read_bytes()), expected,
                             "Only the App's copied plist/entitlements paths and iCloud capability may differ")
            container = "iCloud.tech.dongdongbh.mindwtr.native.dev"
            claims = {"com.apple.developer.icloud-container-identifiers": [container],
                      "com.apple.developer.icloud-services": ["CloudKit"],
                      "com.apple.developer.icloud-container-environment": "Development"}
            for copied, source in [("App.entitlements", "NativeShareDev.entitlements"),
                                   ("Simulator.entitlements", "NativeShareDevSimulator.entitlements")]:
                original = plistlib.loads(originals[Path("App") / source])
                self.assertEqual(plistlib.loads((output / "CloudKit" / copied).read_bytes()), {**original, **claims})
            info = plistlib.loads(originals[Path("App/Info.plist")])
            self.assertEqual(plistlib.loads((output / "CloudKit/Info.plist").read_bytes()),
                             {**info, "NativeCloudKitContainer": container})
            self.assertNotIn("NativeCloudKitContainer", info)
            self.assertFalse((normal / "CloudKit").exists())
            for enabled_cloudkit in [False, True]:
                configured = generator.generate(native, native / ("DropboxCloud.xcodeproj" if enabled_cloudkit else "Dropbox.xcodeproj"),
                                                cloudkit=enabled_cloudkit, dropbox_app_key="synthetic123",
                                                dropbox_redirect_uri="mindwtr-native-dev://redirect")
                relative = "CloudKit/Info.plist" if enabled_cloudkit else "Dropbox/Info.plist"
                configured_info = plistlib.loads((configured / relative).read_bytes())
                self.assertEqual(configured_info, {**info, **({"NativeCloudKitContainer": container} if enabled_cloudkit else {}),
                                                  "MindwtrDropboxAppKey": "synthetic123",
                                                  "MindwtrDropboxRedirectURI": "mindwtr-native-dev://redirect"})
                graph = plistlib.loads((configured / "project.pbxproj").read_bytes())
                for name in ["Debug", "Release"]:
                    self.assertEqual(graph["objects"]["app-" + name]["buildSettings"]["INFOPLIST_FILE"], configured.name + "/" + relative)
            for app_key, redirect in [(None, "mindwtr-native-dev://redirect"), ("synthetic123", None),
                                      ("$(DROPBOX_APP_KEY)", "mindwtr-native-dev://redirect"),
                                      ("synthetic123", "mindwtr://redirect"), ("synthetic123", "mindwtr-native-dev://redirect?code=x")]:
                rejected = native / "RejectedDropbox.xcodeproj"
                with self.assertRaises(ValueError):
                    generator.generate(native, rejected, dropbox_app_key=app_key, dropbox_redirect_uri=redirect)
                self.assertFalse(rejected.exists())
            for relative, encoded in originals.items():
                self.assertEqual((native / relative).read_bytes(), encoded, str(relative))
            reference = ET.fromstring((output / "xcshareddata/xcschemes/MindwtrNative.xcscheme").read_bytes()).find("BuildableReference")
            self.assertEqual(reference.get("BlueprintIdentifier"), "app")
            self.assertEqual(reference.get("ReferencedContainer"), "container:" + generator.CLOUDKIT_OUTPUT)
            frozen = {path.relative_to(output): path.read_bytes() for path in output.rglob("*") if path.is_file()}
            with self.assertRaises(FileExistsError):
                generator.generate(native, output, cloudkit=True)
            self.assertEqual({path.relative_to(output): path.read_bytes() for path in output.rglob("*") if path.is_file()}, frozen)

    def test_cli_cloudkit_flag_uses_separate_default_without_container_override(self):
        for arguments, name, enabled in [([], generator.DEFAULT_OUTPUT, False), (["--cloudkit"], generator.CLOUDKIT_OUTPUT, True)]:
            with patch.object(sys, "argv", ["create-dev-project.py", *arguments]), patch.object(generator, "generate") as generate, patch("builtins.print"):
                generator.main()
                generate.assert_called_once_with(HERE.parent, HERE.parent / name, cloudkit=enabled, watch=False, dropbox_app_key=None, dropbox_redirect_uri=None)
        with patch.object(sys, "argv", ["create-dev-project.py", "--cloudkit", "--container", "iCloud.example.foreign"]), patch("sys.stderr"):
            with self.assertRaises(SystemExit) as refused:
                generator.main()
            self.assertEqual(refused.exception.code, 2)

    def test_watch_companion_graph_resources_info_and_fresh_output(self):
        scratch = HERE.parent / ".build"
        scratch.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="dev-watch-project-test-", dir=scratch) as directory:
            native = Path(directory) / "apps/ios-native"
            for name in [*generator.SHARE_SOURCES, *generator.WIDGET_SOURCES, "App/NativeCaptureIntents.swift",
                         "App/Info.plist", "App/NativeShareDev.entitlements", "App/NativeShareDevSimulator.entitlements"]:
                target = native / name
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(HERE.parent / name, target)
            for name in ["ShareExtension", "CaptureWidget"]:
                shutil.copytree(HERE.parent / name, native / name, dirs_exist_ok=True)
            maintained = HERE.parent.parent / "mobile/targets/watch"
            shutil.copytree(maintained, native.parent / "mobile/targets/watch")
            icon_source = native.parent / "mobile/assets/images/icon.png"
            icon_source.parent.mkdir(parents=True)
            shutil.copyfile(HERE.parent.parent / "mobile/assets/images/icon.png", icon_source)
            scheme = native / generator.BASE / "xcshareddata/xcschemes/MindwtrNative.xcscheme"
            scheme.parent.mkdir(parents=True)
            scheme.write_text('<Scheme><BuildableReference BlueprintIdentifier="app" ReferencedContainer="container:MindwtrNative.xcodeproj"/></Scheme>')
            (native / generator.BASE / "project.pbxproj").write_bytes(plistlib.dumps(base_project()))
            originals = {path: path.read_bytes() for path in Path(directory).rglob("*") if path.is_file()}
            normal = generator.generate(native, native / generator.DEFAULT_OUTPUT)
            normal_files = {path: path.read_bytes() for path in normal.rglob("*") if path.is_file()}
            normal_graph = plistlib.loads((normal / "project.pbxproj").read_bytes())
            for cloudkit, output_name in [(False, generator.WATCH_OUTPUT), (True, generator.WATCH_CLOUDKIT_OUTPUT)]:
                output = generator.generate(native, native / output_name, cloudkit=cloudkit, watch=True, dropbox_app_key=None, dropbox_redirect_uri=None)
                graph = plistlib.loads((output / "project.pbxproj").read_bytes())
                objects = graph["objects"]
                targets = {item["name"]: (key, item) for key, item in objects.items() if item.get("isa") == "PBXNativeTarget"}
                self.assertEqual(set(targets), {"MindwtrNative", "MindwtrNativeUITests", "MindwtrNativeShare",
                                               "MindwtrNativeCaptureWidget", "MindwtrWatch", "MindwtrWatchWidgets"})
                self.assertEqual(targets["MindwtrNative"][0], "app")
                for identifier, item in normal_graph["objects"].items():
                    if identifier not in ["project", "main", "products", "app", "app-Debug", "app-Release"]:
                        self.assertEqual(objects[identifier], item, identifier)
                for name, folder, suffix, extension, widget in [
                    ("MindwtrWatch", "App", ".watchkitapp", ".app", False),
                    ("MindwtrWatchWidgets", "Widgets", ".watchkitapp.widgets", ".appex", True),
                ]:
                    target_id, target = targets[name]
                    self.assertEqual(target["productType"], "com.apple.product-type.app-extension" if widget else "com.apple.product-type.application")
                    self.assertEqual(objects[target["productReference"]]["path"], name + extension)
                    paths = {objects[phase]["isa"]: [objects[objects[build]["fileRef"]]["path"]
                             for build in objects[phase]["files"]] for phase in target["buildPhases"]
                             if objects[phase]["isa"] in ["PBXSourcesBuildPhase", "PBXResourcesBuildPhase"]}
                    expected = [generator.WATCH_ROOT + "/" + str(path.relative_to(maintained))
                                for path in [*sorted((maintained / folder).glob("*.swift")),
                                             *sorted((maintained / "Shared").glob("*.swift"))]]
                    self.assertEqual(paths["PBXSourcesBuildPhase"], expected)
                    expected_resources = [generator.WATCH_ROOT + "/Resources/Localizable.xcstrings",
                                          generator.WATCH_ROOT + "/Resources/PrivacyInfo.xcprivacy"]
                    if not widget:
                        expected_resources.append(output_name + "/Watch/Assets.xcassets")
                    self.assertEqual(paths["PBXResourcesBuildPhase"], expected_resources)
                    for config in objects[target["buildConfigurationList"]]["buildConfigurations"]:
                        settings = objects[config]["buildSettings"]
                        for key, value in {"PRODUCT_BUNDLE_IDENTIFIER": generator.APP + suffix,
                            "MINDWTR_HOST_BUNDLE_IDENTIFIER": generator.APP,
                            "MINDWTR_WATCH_APP_GROUP": "group.tech.dongdongbh.mindwtr.native.dev.watch",
                            "MINDWTR_SPOKEN_NAME": "Mind Water Dev", "SDKROOT": "watchos",
                            "WATCHOS_DEPLOYMENT_TARGET": "10.0", "SWIFT_VERSION": "5.0",
                            "SUPPORTED_PLATFORMS": "watchos watchsimulator", "TARGETED_DEVICE_FAMILY": "4",
                            "CURRENT_PROJECT_VERSION": "42", "MARKETING_VERSION": "1.3.3"}.items():
                            self.assertEqual(settings[key], value, key)
                        self.assertNotIn("IPHONEOS_DEPLOYMENT_TARGET", settings)
                        self.assertFalse(any(key in settings for key in ["DEVELOPMENT_TEAM", "PROVISIONING_PROFILE_SPECIFIER", "CODE_SIGN_STYLE"]))
                        info = plistlib.loads((native / settings["INFOPLIST_FILE"]).read_bytes())
                        claims = plistlib.loads((native / settings["CODE_SIGN_ENTITLEMENTS"]).read_bytes())
                        self.assertEqual(claims, {"com.apple.security.application-groups": ["$(MINDWTR_WATCH_APP_GROUP)"]})
                        self.assertEqual(info["MindwtrWatchAppGroup"], "$(MINDWTR_WATCH_APP_GROUP)")
                        if not widget:
                            self.assertIs(info["WKApplication"], True)
                            self.assertEqual(info["WKCompanionAppBundleIdentifier"], "$(MINDWTR_HOST_BUNDLE_IDENTIFIER)")
                for parent, child, label, destination, subfolder in [
                    ("MindwtrNative", "MindwtrWatch", "Embed Watch Content", "$(CONTENTS_FOLDER_PATH)/Watch", 16),
                    ("MindwtrWatch", "MindwtrWatchWidgets", "Embed Watch Extensions", "", 13),
                ]:
                    target = targets[parent][1]
                    child_id, child_target = targets[child]
                    self.assertIn(child_id, [objects[dependency]["target"] for dependency in target["dependencies"]])
                    embed = next(objects[phase] for phase in target["buildPhases"] if objects[phase].get("name") == label)
                    self.assertEqual((embed["dstPath"], embed["dstSubfolderSpec"]), (destination, subfolder))
                    self.assertEqual([objects[build]["fileRef"] for build in embed["files"]], [child_target["productReference"]])
                    self.assertEqual(objects[embed["files"][0]]["settings"]["ATTRIBUTES"], ["CodeSignOnCopy", "RemoveHeadersOnCopy"])
                    self.assertEqual(objects[target["buildPhases"][-1]], embed)
                host_settings = objects["app-Debug"]["buildSettings"]
                info = plistlib.loads((native / host_settings["INFOPLIST_FILE"]).read_bytes())
                source_info = plistlib.loads(originals[native / "App/Info.plist"])
                self.assertEqual(info, {**source_info, "MindwtrWatchEnabled": True,
                                 **({"NativeCloudKitContainer": generator.CLOUDKIT_CONTAINER} if cloudkit else {})})
                self.assertFalse(source_info.get("MindwtrWatchEnabled", False))
                icon = (output / "Watch/Assets.xcassets/AppIcon.appiconset/AppIcon.png").read_bytes()
                self.assertEqual(icon, (HERE / "create-dev-project-assets/WatchAppIcon.png").read_bytes())
                self.assertEqual(struct.unpack(">IIBBBBB", icon[16:29]), (1024, 1024, 8, 2, 0, 0, 0))
                for item in objects.values():
                    if item.get("isa") == "PBXFileReference" and item.get("sourceTree") == "SOURCE_ROOT":
                        self.assertTrue((native / item["path"]).exists(), item["path"])
                frozen = {path: path.read_bytes() for path in output.rglob("*") if path.is_file()}
                with self.assertRaises(FileExistsError):
                    generator.generate(native, output, cloudkit=cloudkit, watch=True, dropbox_app_key=None, dropbox_redirect_uri=None)
                self.assertEqual({path: path.read_bytes() for path in output.rglob("*") if path.is_file()}, frozen)
            for path, encoded in {**originals, **normal_files}.items():
                self.assertEqual(path.read_bytes(), encoded, str(path))
            icon_source.write_bytes(b"changed icon source")
            refused = native / "ChangedWatchIcon.xcodeproj"
            with self.assertRaisesRegex(ValueError, "Watch icon source changed"):
                generator.generate(native, refused, watch=True)
            self.assertFalse(refused.exists())

    def test_cli_watch_flag_uses_isolated_defaults(self):
        for arguments, name, cloudkit in [(["--watch"], generator.WATCH_OUTPUT, False),
                                         (["--watch", "--cloudkit"], generator.WATCH_CLOUDKIT_OUTPUT, True)]:
            with patch.object(sys, "argv", ["create-dev-project.py", *arguments]), patch.object(generator, "generate") as generate, patch("builtins.print"):
                generator.main()
                generate.assert_called_once_with(HERE.parent, HERE.parent / name, cloudkit=cloudkit, watch=True, dropbox_app_key=None, dropbox_redirect_uri=None)


if __name__ == "__main__":
    unittest.main()
