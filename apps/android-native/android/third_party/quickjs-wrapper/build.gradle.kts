plugins {
    id("com.android.library")
}

android {
    namespace = "com.whl.quickjs.android"
    compileSdk = 36
    ndkVersion = "27.1.12297006"

    defaultConfig {
        minSdk = 24
        consumerProguardFiles("consumer-rules.pro")
        externalNativeBuild { cmake { arguments += "-DCMAKE_BUILD_TYPE=Release" } }
    }

    buildTypes {
        create("upgradetest") { initWith(getByName("debug")) }
        listOf("benchmark", "benchmarkSeed", "benchmarkTrace").forEach { create(it) { initWith(getByName("release")) } }
    }

    sourceSets {
        getByName("main").java.srcDirs("wrapper-java/src/main/java", "wrapper-android/src/main/java")
    }

    externalNativeBuild { cmake { path = file("CMakeLists.txt") } }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}
