plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}


val tracedBundleAssets = layout.buildDirectory.dir("generated/traced-bundle/assets")


val urlSchemes = mapOf("debug" to "mindwtr-native-dev", "upgradetest" to "mindwtr-upgradetest", "release" to "mindwtr") +
    mapOf("benchmark" to "mindwtr-native-bench", "benchmarkSeed" to "mindwtr-native-bench", "benchmarkTrace" to "mindwtr-native-bench")


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


val rnHeartbeatUrl = if (System.getenv("ANALYTICS_HEARTBEAT_DISABLED") in setOf("1", "true")) "" else
    (System.getenv("ANALYTICS_HEARTBEAT_URL") ?: "").trim().ifEmpty { "https://mindwtr-analytics.mindwtr.workers.dev/" }
val rnHeartbeatChannel = System.getenv("ANALYTICS_HEARTBEAT_CHANNEL")

val rnDonationPrompt = System.getenv("DONATION_PROMPT_ENABLED") in setOf("1", "true")
val quickjsVersion = rootProject.projectDir.resolve("third_party/quickjs-wrapper/quickjs/VERSION").readText().trim()
fun quoted(value: String) = "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"") + "\""


val packages = mapOf("debug" to "tech.dongdongbh.mindwtr.nativeclient.dev", "upgradetest" to "tech.dongdongbh.mindwtr.upgradetest",
    "release" to rnPackage) +
    listOf("benchmark", "benchmarkSeed", "benchmarkTrace").associateWith { "tech.dongdongbh.mindwtr.nativeclient.dev.benchmark" }
val launcherLabels = mapOf("debug" to "Mindwtr Native Dev", "upgradetest" to "Mindwtr Native Dev", "release" to rnName) +
    listOf("benchmark", "benchmarkSeed", "benchmarkTrace").associateWith { "Mindwtr" }
fun com.android.build.api.dsl.ApplicationBuildType.launcherIdentity() {
    val scheme = urlSchemes.getValue(name)
    buildConfigField("String", "URL_SCHEME", "\"$scheme\"")
    manifestPlaceholders["urlScheme"] = scheme
    manifestPlaceholders["appLabel"] = launcherLabels.getValue(name)
}

android {
    namespace = "tech.dongdongbh.mindwtr.pilot"
    compileSdk = 36

    defaultConfig {
        applicationId = "tech.dongdongbh.mindwtr.nativeclient.dev"
        minSdk = 24
        targetSdk = 36
        versionCode = 1
        versionName = "native-dev"

        buildConfigField("boolean", "RN_STORAGE", "false")

        buildConfigField("String", "QUICKJS_ENGINE", quoted("quickjs-$quickjsVersion"))
        buildConfigField("String", "RN_NAME", quoted(rnName))
        buildConfigField("String", "RN_PACKAGE", quoted(rnPackage))
        buildConfigField("String", "RN_VERSION", quoted(rnVersion))
        buildConfigField("String", "RN_VERSION_CODE", quoted(rnVersionCode))
        buildConfigField("String", "RN_RELEASE_VERSION", quoted(rnReleaseVersion))
        buildConfigField("String", "FEEDBACK_ENDPOINT_URL", quoted(rnFeedbackUrl))
        buildConfigField("String", "ANALYTICS_HEARTBEAT_URL", "\"\"")

        externalNativeBuild { cmake { cppFlags += "-std=c++17 -Wall -Wextra -Werror" } }
        buildConfigField("boolean", "DONATION_PROMPT", "false")
    }


    ndkVersion = "27.1.12297006"
    externalNativeBuild { cmake { path = file("../../../mobile/modules/sync-file-lock/android/src/main/cpp/CMakeLists.txt") } }

    buildTypes {
        getByName("debug") { launcherIdentity() }

        getByName("release") {
            buildConfigField("boolean", "RN_STORAGE", "true")
            buildConfigField("String", "ANALYTICS_HEARTBEAT_URL", quoted(rnHeartbeatUrl))
            buildConfigField("boolean", "DONATION_PROMPT", rnDonationPrompt.toString())
            launcherIdentity()
        }


        create("upgradetest") {
            initWith(getByName("debug"))
            buildConfigField("boolean", "RN_STORAGE", "true")
            launcherIdentity()
        }


        create("benchmark") {
            initWith(getByName("release"))
            applicationIdSuffix = ".benchmark"
            signingConfig = signingConfigs.getByName("debug")

            buildConfigField("boolean", "RN_STORAGE", "false")
            isMinifyEnabled = true
            isProfileable = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"))
            buildConfigField("String", "ANALYTICS_HEARTBEAT_URL", "\"\"")
            buildConfigField("boolean", "DONATION_PROMPT", "false")
            launcherIdentity()
        }


        create("benchmarkSeed") {
            initWith(getByName("benchmark"))
            isDebuggable = true
            isMinifyEnabled = false
            launcherIdentity()
        }

        create("benchmarkTrace") {
            initWith(getByName("benchmark"))
            launcherIdentity()
        }
    }


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

            buildConfigField("String", "ANALYTICS_HEARTBEAT_CHANNEL", quoted(rnHeartbeatChannel ?: if (rnHeartbeatUrl.isNotEmpty()) "fdroid" else ""))
        }
    }


    sourceSets { urlSchemes.keys.forEach { getByName(it).res.srcDir(layout.buildDirectory.dir("generated/shortcuts/$it/res")) } }


    sourceSets {
        getByName("main").java.srcDir(layout.buildDirectory.dir("generated/rnInstaller/main/java"))
        getByName("main").java.srcDir(layout.buildDirectory.dir("generated/rnPersistentCapture"))
        getByName("test").java.srcDir(layout.buildDirectory.dir("generated/rnInstaller/test/java"))

        getByName("main").java.srcDir(layout.buildDirectory.dir("generated/rnFileSync/main/java"))
        getByName("test").java.srcDir(layout.buildDirectory.dir("generated/rnFileSync/test/java"))

        getByName("play").java.srcDir(layout.buildDirectory.dir("generated/rnGmail/main/java"))
        getByName("testPlay").java.srcDir(layout.buildDirectory.dir("generated/rnGmail/test/java"))
        urlSchemes.keys.forEach { type ->
            val widgets = layout.buildDirectory.dir("generated/widgets/$type").get().asFile
            getByName(type).res.srcDir(widgets.resolve("res"))
            getByName(type).java.srcDir(widgets.resolve("java"))
        }
    }

    sourceSets { getByName("benchmarkTrace").assets.srcDir(tracedBundleAssets) }


    buildFeatures { compose = true; buildConfig = true }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions { jvmTarget = "17" }

}


androidComponents {


    onVariants { variant ->
        listOf("widgets", "shortcuts").forEach { set ->
            variant.sources.manifests?.addStaticManifestFile(layout.buildDirectory.file("generated/$set/${variant.buildType}/AndroidManifest.xml").get().asFile.path)
        }
    }


    onVariants { variant ->
        val flag = mapOf("debug" to "MINDWTR_GMAIL_DEV_ENABLED", "release" to "MINDWTR_GMAIL_PRODUCTION_VERIFIED")[variant.buildType]
        val gmail = variant.flavorName == "play" && flag != null && System.getenv(flag) == "1"
        variant.manifestPlaceholders.put("gmailEnabled", gmail.toString())
    }
    onVariants(selector().withBuildType("upgradetest")) { variant ->
        variant.applicationId.set("tech.dongdongbh.mindwtr.upgradetest")
        variant.outputs.forEach { it.versionCode.set(153) }
    }


    onVariants(selector().withBuildType("release")) { variant ->
        variant.applicationId.set(rnPackage)
        variant.outputs.forEach { it.versionCode.set(rnVersionCode.toInt()); it.versionName.set(rnVersion) }
    }


    val identityScript = rootProject.projectDir.resolve("../scripts/check-variant-identity.mjs").path
    onVariants { variant ->
        val manifest = variant.artifacts.get(com.android.build.api.artifact.SingleArtifact.MERGED_MANIFEST)
        val shortcuts = layout.buildDirectory.file("generated/shortcuts/${variant.buildType}/res/xml/mindwtr_shortcuts.xml")
        val linkScheme = layout.buildDirectory.file("generated/shortcuts/${variant.buildType}/res/values/mindwtr_link_scheme.xml")
        val name = variant.name.replaceFirstChar(Char::uppercase)
        val buildConfig = layout.buildDirectory.file("generated/source/buildConfig/${variant.flavorName}/${variant.buildType}/tech/dongdongbh/mindwtr/pilot/BuildConfig.java")
        val check = tasks.register<Exec>("check${name}Identity") {
            dependsOn("buildShortcuts", "generate${name}BuildConfig")
            inputs.file(manifest)
            commandLine("node", identityScript, variant.buildType!!)
            argumentProviders.add(CommandLineArgumentProvider { listOf(manifest, shortcuts, buildConfig, linkScheme).map { it.get().asFile.path } })
        }
        tasks.named("checkVariantIdentity") { dependsOn(check) }
    }
}


val checkFossDependencies by tasks.registering {
    doLast {
        val banned = listOf("com.google.android.gms", "com.google.firebase", "com.google.mlkit", "com.google.android.play",
            "com.google.android.datatransport", "com.google.android.ump", "com.android.billingclient", "com.android.installreferrer")
        val found = listOf("fossDebugRuntimeClasspath", "fossReleaseRuntimeClasspath").flatMap { name ->
            configurations.getByName(name).incoming.resolutionResult.allComponents
                .mapNotNull { (it.id as? org.gradle.api.artifacts.component.ModuleComponentIdentifier)?.let { id -> "${id.group}:${id.module}" } }
        }.distinct().filter { module -> banned.any { group -> module.startsWith("$group:") || module.startsWith("$group.") } }
        if (found.isNotEmpty()) throw GradleException("The FOSS build depends on Google Play libraries: ${found.joinToString()}")
        logger.lifecycle("checkFossDependencies: the FOSS runtime classpaths hold no Google Play library")
    }
}
val checkVariantIdentity by tasks.registering { dependsOn(checkFossDependencies) }


val sqliteVersion = "2.7.1"

dependencies {
    implementation(project(":quickjs-wrapper"))


    implementation("androidx.sqlite:sqlite-bundled:$sqliteVersion")

    implementation("com.squareup.okhttp3:okhttp:4.12.0")


    "playImplementation"("com.google.android.play:app-update:2.1.0")
    "playImplementation"("com.google.android.play:review:2.0.1")
    "playImplementation"("com.android.installreferrer:installreferrer:2.2")

    "playImplementation"("com.google.android.gms:play-services-auth:22.0.0")
    implementation("androidx.activity:activity-compose:1.10.1")

    implementation("androidx.core:core-splashscreen:1.2.0-alpha02")
    implementation(platform("androidx.compose:compose-bom:2025.08.01"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.material3:material3")

    implementation("androidx.biometric:biometric:1.2.0-alpha04")

    implementation("androidx.fragment:fragment:1.8.9")

    implementation("androidx.work:work-runtime:2.9.1")


    implementation("androidx.appsearch:appsearch:1.2.0-alpha01")
    implementation("androidx.appsearch:appsearch-platform-storage:1.2.0-alpha01")
    implementation("com.google.guava:guava:33.3.1-android")

    implementation(project(":widget"))

    implementation("org.bouncycastle:bcprov-jdk18on:1.86")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")

    testImplementation("androidx.sqlite:sqlite-bundled-jvm:$sqliteVersion")
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

val buildWidgets by tasks.registering(Exec::class) {
    workingDir = rootProject.projectDir.resolve("../../..")
    val out = layout.buildDirectory.dir("generated/widgets").get().asFile
    commandLine(listOf("node", "apps/android-native/scripts/build-widgets.mjs", out.path) + packages.map { (type, id) -> "$type=$id:${launcherLabels.getValue(type)}" })
    inputs.files(
        fileTree(workingDir.resolve("apps/mobile/plugins")),
        fileTree(workingDir.resolve("apps/mobile/modules/android-widget/android/src/main/res/layout")),
        workingDir.resolve("apps/mobile/app.json"),
        fileTree(workingDir.resolve("apps/mobile/assets/images")) { include("widget-*.png") },
        workingDir.resolve("apps/android-native/scripts/build-widgets.mjs"),
    )
    inputs.property("packages", packages.toString())
    inputs.property("launcherLabels", launcherLabels.toString())
    outputs.dir(out)
}


val rnAttachmentInstaller by tasks.registering(Sync::class) {
    val installer = "tech/dongdongbh/mindwtr/attachmentfileinstaller"
    from(rootProject.projectDir.resolve("../../mobile/modules/attachment-file-installer/android/src")) {
        include(listOf("AttachmentFileInstallerCore", "AndroidAttachmentInstallerFileOps").map { "main/java/$installer/$it.kt" })
        include(listOf("AttachmentFileInstallerCoreTest", "AndroidAttachmentInstallerFileOpsTest").map { "test/java/$installer/$it.kt" })
    }
    into(layout.buildDirectory.dir("generated/rnInstaller"))
}


val rnFileSync by tasks.registering(Sync::class) {
    val cas = "tech/dongdongbh/mindwtr/syncfiletransitioncas"
    val lock = "tech/dongdongbh/mindwtr/syncfilelock"
    from(rootProject.projectDir.resolve("../../mobile/modules/sync-file-transition-cas/android/src")) {
        include(listOf("SafDocumentsCore", "AndroidSafDocumentProvider", "SyncFileTransitionCasCore").map { "main/java/$cas/$it.kt" })
        include("test/java/$cas/SafDocumentsCoreTest.kt")
    }
    from(rootProject.projectDir.resolve("../../mobile/modules/sync-file-lock/android/src")) {
        include("main/java/$lock/SyncFileLockCore.kt")
        include("test/java/$lock/SyncFileLockModuleTest.kt")
    }
    into(layout.buildDirectory.dir("generated/rnFileSync"))
}

val rnPersistentCapture by tasks.registering(Sync::class) {
    from(rootProject.projectDir.resolve("../../mobile/modules/notification-open-intents/android/src/main/java")) {
        include("tech/dongdongbh/mindwtr/notificationopenintents/PersistentCaptureNotifier.kt")
    }
    into(layout.buildDirectory.dir("generated/rnPersistentCapture"))
}


val rnGmail by tasks.registering(Sync::class) {
    val gmail = "tech/dongdongbh/mindwtr/gmailauthorization"
    from(rootProject.projectDir.resolve("../../mobile/modules/gmail-authorization/android/src")) {
        include("main/java/$gmail/GmailAuthorizationCore.kt")
        include("test/java/$gmail/GmailAuthorizationCoreTest.kt")
    }
    into(layout.buildDirectory.dir("generated/rnGmail"))
}
tasks.named("preBuild") { dependsOn(buildCoreBundle, buildShortcuts, buildWidgets, rnAttachmentInstaller, rnPersistentCapture, rnFileSync, rnGmail) }
tasks.matching { it.name.startsWith("pre") && it.name.endsWith("BenchmarkTraceBuild") }.configureEach { dependsOn(buildTracedCoreBundle) }


tasks.register("testDebugUnitTest") { dependsOn("testPlayDebugUnitTest", "testFossDebugUnitTest", ":widget:testDebugUnitTest", checkVariantIdentity) }
