plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

// Where Gradle's buildTracedCoreBundle writes the module-traced bundle (benchmarkTrace's assets).
val tracedBundleAssets = layout.buildDirectory.dir("generated/traced-bundle/assets")

// The app's link scheme by build type (D6): the development build has its own, so RN's app on the same phone keeps
// mindwtr:// links; the upgrade harness keeps its RN build's scheme; a release keeps RN's. The manifest's link filter, the
// shortcuts (scripts/build-shortcuts.mjs), and BuildConfig.URL_SCHEME (the scheme core reads links for) use it.
val urlSchemes = mapOf("debug" to "mindwtr-native-dev", "upgradetest" to "mindwtr-upgradetest", "release" to "mindwtr") +
    mapOf("benchmark" to "mindwtr-native-bench", "benchmarkSeed" to "mindwtr-native-bench", "benchmarkTrace" to "mindwtr-native-bench")
// Each build type's package (defaultConfig's; the upgradetest one is set in androidComponents below, the benchmarks' by their
// suffix), which RN's shortcuts and legacy widget class name, and the widgets' launcher label.
val packages = mapOf("debug" to "tech.dongdongbh.mindwtr.nativeclient.dev", "upgradetest" to "tech.dongdongbh.mindwtr.upgradetest",
    "release" to "tech.dongdongbh.mindwtr.nativeclient.dev") +
    listOf("benchmark", "benchmarkSeed", "benchmarkTrace").associateWith { "tech.dongdongbh.mindwtr.nativeclient.dev.benchmark" }
val widgetLabels = mapOf("debug" to "Mindwtr Native Dev", "upgradetest" to "Mindwtr Native Dev", "release" to "Mindwtr") +
    listOf("benchmark", "benchmarkSeed", "benchmarkTrace").associateWith { "Mindwtr" }
fun com.android.build.api.dsl.ApplicationBuildType.urlScheme() {
    val scheme = urlSchemes.getValue(name)
    buildConfigField("String", "URL_SCHEME", "\"$scheme\"")
    manifestPlaceholders["urlScheme"] = scheme
}

// RN's build facts (apps/mobile/app.json and app.config.ts), so About, feedback and the heartbeat report what RN's same build
// reports: the version and build number, the release tag (release-version.json, else ANALYTICS_RELEASE_VERSION), and the
// endpoints from the same environment variables. The benchmarks never send a heartbeat (RN's benchmark variant has none).
val rnAppJson = groovy.json.JsonSlurper().parse(rootProject.projectDir.resolve("../../mobile/app.json")) as Map<*, *>
val rnExpo = rnAppJson["expo"] as Map<*, *>
val rnVersion = rnExpo["version"] as String
val rnVersionCode = ((rnExpo["android"] as Map<*, *>)["versionCode"] as Number).toString()
val rnName = rnExpo["name"] as String
val rnPackage = (rnExpo["android"] as Map<*, *>)["package"] as String
val rnReleaseVersion = (System.getenv("ANALYTICS_RELEASE_VERSION") ?: "").trim().ifEmpty {
    runCatching { ((groovy.json.JsonSlurper().parse(rootProject.projectDir.resolve("../../mobile/release-version.json")) as Map<*, *>)["releaseVersion"] as String).trim() }.getOrDefault("")
}
val rnFeedbackUrl = (System.getenv("FEEDBACK_ENDPOINT_URL") ?: "").trim()
// RN's builds default to the live heartbeat endpoint; this app is not a production build yet (it ships under the dev package),
// so its heartbeat is on only when ANALYTICS_HEARTBEAT_URL names one. The production identity pass (O3) restores RN's default.
val rnHeartbeatUrl = if (System.getenv("ANALYTICS_HEARTBEAT_DISABLED") in setOf("1", "true")) "" else
    (System.getenv("ANALYTICS_HEARTBEAT_URL") ?: "").trim()
val rnHeartbeatChannel = System.getenv("ANALYTICS_HEARTBEAT_CHANNEL")
fun quoted(value: String) = "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"") + "\""

android {
    namespace = "tech.dongdongbh.mindwtr.pilot"
    compileSdk = 36

    defaultConfig {
        applicationId = "tech.dongdongbh.mindwtr.nativeclient.dev"
        minSdk = 24
        targetSdk = 36
        versionCode = 1
        versionName = "native-dev"
        // false: the isolated dev database. Only the upgradetest build type opens the RN app's storage.
        buildConfigField("boolean", "RN_STORAGE", "false")
        // The QuickJS wrapper's version (the dependency below): a key of the bundle's bytecode cache (BytecodeCache.kt).
        buildConfigField("String", "QUICKJS_WRAPPER", "\"3.2.0\"")
        buildConfigField("String", "RN_NAME", quoted(rnName))
        buildConfigField("String", "RN_PACKAGE", quoted(rnPackage))
        buildConfigField("String", "RN_VERSION", quoted(rnVersion))
        buildConfigField("String", "RN_VERSION_CODE", quoted(rnVersionCode))
        buildConfigField("String", "RN_RELEASE_VERSION", quoted(rnReleaseVersion))
        buildConfigField("String", "FEEDBACK_ENDPOINT_URL", quoted(rnFeedbackUrl))
        buildConfigField("String", "ANALYTICS_HEARTBEAT_URL", quoted(rnHeartbeatUrl))
    }

    buildTypes {
        getByName("debug") { urlScheme() }
        getByName("release") { urlScheme() }
        // Upgrade harness only (scripts/check-upgrade-device.mjs): installs in place over the
        // RN v1.3.2 harness build, package tech.dongdongbh.mindwtr.upgradetest, and opens its files.
        create("upgradetest") {
            initWith(getByName("debug"))
            buildConfigField("boolean", "RN_STORAGE", "true")
            urlScheme()
        }
        // Startup measurement only (scripts/measure-startup-device.mjs): a release build (R8, not debuggable)
        // that the shell may profile, signed with the debug key, under its own id so it never shares the dev app's data.
        create("benchmark") {
            initWith(getByName("release"))
            applicationIdSuffix = ".benchmark"
            signingConfig = signingConfigs.getByName("debug")
            isMinifyEnabled = true
            isProfileable = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"))
            buildConfigField("String", "ANALYTICS_HEARTBEAT_URL", "\"\"")
            urlScheme()
        }
        // The benchmark's debuggable twin (same id and key): installed first so run-as can seed a database, then the
        // benchmark build installs over it and keeps that data.
        create("benchmarkSeed") {
            initWith(getByName("benchmark"))
            isDebuggable = true
            isMinifyEnabled = false
            urlScheme()
        }
        // The benchmark build with the module-traced bundle (buildTracedCoreBundle below): startup measurement only.
        create("benchmarkTrace") {
            initWith(getByName("benchmark"))
            urlScheme()
        }
    }

    // RN's two Android channels (D8) as product flavors: RN builds one or the other with FOSS_BUILD (apps/mobile/app.config.ts).
    // A FOSS build hides Dropbox and the Play-only parts and defaults speech to offline Whisper: core reads BuildConfig.FOSS as
    // RN's isFossBuild. Both keep RN's package; a channel is its signing key.
    flavorDimensions += "channel"
    productFlavors {
        create("play") {
            dimension = "channel"
            buildConfigField("boolean", "FOSS", "false")
            buildConfigField("String", "ANALYTICS_HEARTBEAT_CHANNEL", quoted(rnHeartbeatChannel ?: ""))
        }
        create("foss") {
            dimension = "channel"
            buildConfigField("boolean", "FOSS", "true")
            // RN's FOSS default: fdroid while the heartbeat is on.
            buildConfigField("String", "ANALYTICS_HEARTBEAT_CHANNEL", quoted(rnHeartbeatChannel ?: if (rnHeartbeatUrl.isNotEmpty()) "fdroid" else ""))
        }
    }

    // RN's app shortcuts, generated per build type (buildShortcuts below).
    sourceSets { urlSchemes.keys.forEach { getByName(it).res.srcDir(layout.buildDirectory.dir("generated/shortcuts/$it/res")) } }
    // RN's attachment installer Kotlin, with its JVM tests, compiled as it is (rnAttachmentInstaller below); RN's widget
    // components, generated per build type from RN's plugins (buildWidgets below): their XML and resources, the legacy widget
    // class and the Quick Settings tile; their manifest entries are added to each variant below.
    sourceSets {
        getByName("main").java.srcDir(layout.buildDirectory.dir("generated/rnInstaller/main/java"))
        getByName("test").java.srcDir(layout.buildDirectory.dir("generated/rnInstaller/test/java"))
        urlSchemes.keys.forEach { type ->
            val widgets = layout.buildDirectory.dir("generated/widgets/$type").get().asFile
            getByName(type).res.srcDir(widgets.resolve("res"))
            getByName(type).java.srcDir(widgets.resolve("java"))
        }
    }
    // Its core-host.js replaces main's in benchmarkTrace only (a build type's assets win over main's).
    sourceSets { getByName("benchmarkTrace").assets.srcDir(tracedBundleAssets) }

    // BuildConfig.DEBUG gates the lifecycle check's fault hooks.
    buildFeatures { compose = true; buildConfig = true }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions { jvmTarget = "17" }

}

// A build type cannot replace applicationId; the variant API can. 152 = RN v1.3.2, 154 = RN recovery build.
androidComponents {
    // RN's widget components' manifest entries (buildWidgets), merged as one more manifest of each variant, so a build type's own
    // manifest (the debug build's check entries) stays.
    onVariants { variant ->
        variant.sources.manifests?.addStaticManifestFile(layout.buildDirectory.file("generated/widgets/${variant.buildType}/AndroidManifest.xml").get().asFile.path)
    }
    onVariants(selector().withBuildType("upgradetest")) { variant ->
        variant.applicationId.set("tech.dongdongbh.mindwtr.upgradetest")
        variant.outputs.forEach { it.versionCode.set(153) }
    }
}

dependencies {
    implementation("wang.harlon.quickjs:wrapper-android:3.2.0")
    // Android's system SQLite does not guarantee FTS5, which core schema needs.
    implementation("androidx.sqlite:sqlite-bundled:2.7.1")
    // RN's fetch runs on OkHttp; the host's fetch uses it too (HostIo.kt), so redirects, TLS and cleartext match RN's.
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    // RN's Play-only modules, in the Play channel alone (RN's FOSS build drops them, scripts/verify_foss_no_google_services.py):
    // Google Play's in-app update answer (modules/play-store-updates), its review flow (expo-store-review) and the install
    // referrer (expo-application), at RN's versions.
    "playImplementation"("com.google.android.play:app-update:2.1.0")
    "playImplementation"("com.google.android.play:review:2.0.1")
    "playImplementation"("com.android.installreferrer:installreferrer:2.2")
    implementation("androidx.activity:activity-compose:1.10.1")
    implementation(platform("androidx.compose:compose-bom:2025.08.01"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.material3:material3")
    // RN's app lock prompt, as expo-local-authentication asks it (its version).
    implementation("androidx.biometric:biometric:1.2.0-alpha04")
    // biometric asks for fragment 1.2.5, which predates activity 1.10's result registry; MainActivity is a FragmentActivity.
    implementation("androidx.fragment:fragment:1.8.9")
    // CoreWork (D7): work after the app closes, on the WorkManager RN ships (expo-background-task's version).
    implementation("androidx.work:work-runtime:2.9.1")
    // RN's home-screen widgets, quick capture dialog and capture intent (apps/mobile/modules/android-widget, widget/build.gradle.kts).
    implementation(project(":widget"))
    // Sync encryption's Argon2id (D3, HostCrypto.kt): BouncyCastle's, under its MIT-style licence; AES-GCM is the platform's.
    implementation("org.bouncycastle:bcprov-jdk18on:1.86")
    // JVM unit tests of plain Kotlin (the entry queue, WriteJournalTest); Android's org.json is a stub there.
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
}

val buildCoreBundle by tasks.registering(Exec::class) {
    workingDir = rootProject.projectDir.resolve("../../..")
    commandLine("node", "apps/android-native/scripts/build-bundle.mjs")
    inputs.files(
        fileTree(workingDir.resolve("packages/core/src")),
        fileTree(workingDir.resolve("apps/android-native/bundle")),
        workingDir.resolve("apps/android-native/scripts/build-bundle.mjs"),
        workingDir.resolve("bun.lock"),
        workingDir.resolve("package.json"),
        workingDir.resolve("packages/core/package.json"),
    )
    outputs.file("src/main/assets/core-host.js")
}
// Every variant's merged assets: the bundle's hash line must be the SHA-256 of its body, and only benchmarkTrace's may carry
// module hooks (verify-bundle.mjs), or the build fails, so the cache's key belongs to the bundle that ships and no traced
// bundle ships.
val verifyBundle = rootProject.projectDir.resolve("../scripts/verify-bundle.mjs").path
tasks.withType<com.android.build.gradle.tasks.MergeSourceSetFolders>().configureEach {
    if (name.startsWith("merge") && name.endsWith("Assets") && !name.contains("Test")) {
        val execs = providers
        doLast {
            val traced = if (name.endsWith("BenchmarkTraceAssets")) "--allow-module-trace" else null
            execs.exec { commandLine(listOfNotNull("node", verifyBundle, outputDir.get().asFile.resolve("core-host.js").path, traced)) }.result.get().assertNormalExitValue()
        }
    }
}
// The module-traced bundle, for benchmarkTrace alone: its own output, never src/main/assets.
val buildTracedCoreBundle by tasks.registering(Exec::class) {
    workingDir = rootProject.projectDir.resolve("../../..")
    val tracedBundle = tracedBundleAssets.map { it.file("core-host.js") }
    commandLine("node", "apps/android-native/scripts/build-bundle.mjs", "--trace-modules", "--out", tracedBundle.get().asFile.path)
    inputs.files(buildCoreBundle.map { it.inputs.files })
    outputs.file(tracedBundle)
}
val buildShortcuts by tasks.registering(Exec::class) {
    workingDir = rootProject.projectDir.resolve("../../..")
    val out = layout.buildDirectory.dir("generated/shortcuts").get().asFile
    commandLine(listOf("node", "apps/android-native/scripts/build-shortcuts.mjs", out.path) + urlSchemes.map { (type, scheme) -> "$type=$scheme@${packages.getValue(type)}" })
    inputs.files(
        workingDir.resolve("apps/mobile/plugins/android-app-shortcuts.js"),
        workingDir.resolve("apps/android-native/scripts/build-shortcuts.mjs"),
    )
    inputs.property("urlSchemes", urlSchemes.toString())
    inputs.property("packages", packages.toString())
    outputs.dir(out)
}
// RN's widgets and tile for each build type (scripts/build-widgets.mjs, from RN's plugins), labelled as the build's launcher icon.
val buildWidgets by tasks.registering(Exec::class) {
    workingDir = rootProject.projectDir.resolve("../../..")
    val out = layout.buildDirectory.dir("generated/widgets").get().asFile
    commandLine(listOf("node", "apps/android-native/scripts/build-widgets.mjs", out.path) + packages.map { (type, id) -> "$type=$id:${widgetLabels.getValue(type)}" })
    inputs.files(
        fileTree(workingDir.resolve("apps/mobile/plugins")),
        fileTree(workingDir.resolve("apps/mobile/modules/android-widget/android/src/main/res/layout")),
        workingDir.resolve("apps/mobile/app.json"),
        fileTree(workingDir.resolve("apps/mobile/assets/images")) { include("widget-*.png") },
        workingDir.resolve("apps/android-native/scripts/build-widgets.mjs"),
    )
    inputs.property("packages", packages.toString())
    inputs.property("widgetLabels", widgetLabels.toString())
    outputs.dir(out)
}
// RN's attachment installer (apps/mobile/modules/attachment-file-installer): its install, hash and journal recovery policy and its
// Android file operations, with RN's JVM tests of both (the hard-link fallback and its errno names, #1139, included). The native publisher (C++) that only File Sync's immutable publication
// loads is not built: File Sync is not on this host yet (S5), and nothing here reaches it.
val rnAttachmentInstaller by tasks.registering(Sync::class) {
    val installer = "tech/dongdongbh/mindwtr/attachmentfileinstaller"
    from(rootProject.projectDir.resolve("../../mobile/modules/attachment-file-installer/android/src")) {
        include(listOf("AttachmentFileInstallerCore", "AndroidAttachmentInstallerFileOps").map { "main/java/$installer/$it.kt" })
        include(listOf("AttachmentFileInstallerCoreTest", "AndroidAttachmentInstallerFileOpsTest").map { "test/java/$installer/$it.kt" })
    }
    into(layout.buildDirectory.dir("generated/rnInstaller"))
}
tasks.named("preBuild") { dependsOn(buildCoreBundle, buildShortcuts, buildWidgets, rnAttachmentInstaller) }
tasks.matching { it.name.startsWith("pre") && it.name.endsWith("BenchmarkTraceBuild") }.configureEach { dependsOn(buildTracedCoreBundle) }
// Both channels' JVM tests under the one name the gates and CI run (flavors leave no testDebugUnitTest), with the widget module's
// RN tests (Robolectric).
tasks.register("testDebugUnitTest") { dependsOn("testPlayDebugUnitTest", "testFossDebugUnitTest", ":widget:testDebugUnitTest") }
