import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("nano_build", Path(__file__).with_name("check-nano-build.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class BuildBoundaryTests(unittest.TestCase):
    def test_app_runtime_rejects_the_device_crash_dependency_graph(self):
        graph = "\n".join([
            "org.jetbrains.kotlin:kotlin-stdlib:2.1.20 -> 2.3.21",
            "org.jetbrains.kotlin:kotlin-stdlib:{prefer 2.0.21} -> 2.3.21 (*)",
            "org.jetbrains.kotlinx:kotlinx-coroutines-core-jvm:1.9.0 -> 1.11.0",
            "org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0 -> 1.11.0",
            "org.jetbrains.kotlinx:kotlinx-coroutines-guava:1.5.0 -> 1.11.0",
        ])
        module.validate_runtime(graph)
        for incompatible in [graph.replace(" -> 1.11.0", " -> 1.9.0"), ""]:
            with self.assertRaises(ValueError):
                module.validate_runtime(incompatible)

    def test_disabled_build_rejects_google_genai_and_floor_changes(self):
        module.validate("disabled", "androidx.core:core:1.16.0", 24)
        for graph, sdk in [("com.google.mlkit:genai-common:1.0.0", 24), ("", 26)]:
            with self.assertRaises(ValueError):
                module.validate("disabled", graph, sdk)

    def test_enabled_build_requires_resolved_pin(self):
        module.validate("enabled", "+--- com.google.mlkit:genai-prompt:1.0.0-beta4", 26)
        for graph in ["", "com.google.mlkit:genai-prompt:1.0.0-beta4 -> 1.0.0-beta5", "com.google.mlkit:genai-prompt:1.0.0-beta4 FAILED"]:
            with self.assertRaises(ValueError):
                module.validate("enabled", graph, 26)


if __name__ == "__main__":
    unittest.main()
