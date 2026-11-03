plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}


val rnModule = rootProject.projectDir.resolve("../../mobile/modules/android-widget/android")
val rnExcluded = listOf("AndroidWidgetModule", "CaptureSyncHeadlessService")

android {
    namespace = "tech.dongdongbh.mindwtr.androidwidget"
    compileSdk = 36

    defaultConfig { minSdk = 24 }


    buildTypes {
        create("upgradetest") { initWith(getByName("debug")) }
        listOf("benchmark", "benchmarkSeed", "benchmarkTrace").forEach { create(it) { initWith(getByName("release")) } }
    }

    sourceSets {

        getByName("main").java.srcDir(layout.buildDirectory.dir("generated/rnWidget/main/java"))
        getByName("test").java.srcDir(layout.buildDirectory.dir("generated/rnWidget/test/java"))
    }

    testOptions { unitTests.isIncludeAndroidResources = true }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions { jvmTarget = "17" }
}

dependencies {

    implementation("androidx.appcompat:appcompat:1.7.0")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
    testImplementation("androidx.test:core:1.6.1")
    testImplementation("org.robolectric:robolectric:4.14.1")
}

val rnWidget by tasks.registering(Sync::class) {
    from(rnModule.resolve("src")) {
        include("main/java/**", "test/java/**")
        exclude(rnExcluded.map { "main/java/**/$it.kt" })
    }
    into(layout.buildDirectory.dir("generated/rnWidget"))
}
tasks.named("preBuild") { dependsOn(rnWidget) }
