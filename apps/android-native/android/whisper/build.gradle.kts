plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "tech.dongdongbh.mindwtr.whisper"
    compileSdk = 36
    ndkVersion = "27.1.12297006"

    defaultConfig {
        minSdk = 24
        externalNativeBuild { cmake { arguments += "-DCMAKE_BUILD_TYPE=Release" } }
    }

    buildTypes {
        create("upgradetest") { initWith(getByName("debug")) }
        listOf("benchmark", "benchmarkSeed", "benchmarkTrace").forEach { create(it) { initWith(getByName("release")) } }
    }

    externalNativeBuild { cmake { path = file("CMakeLists.txt") } }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions { jvmTarget = "17" }
}
