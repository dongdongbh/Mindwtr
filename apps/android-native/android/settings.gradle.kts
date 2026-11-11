pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}
rootProject.name = "mindwtr-android-native"
include(":app")

include(":widget")
include(":quickjs-wrapper")
project(":quickjs-wrapper").projectDir = file("third_party/quickjs-wrapper")
