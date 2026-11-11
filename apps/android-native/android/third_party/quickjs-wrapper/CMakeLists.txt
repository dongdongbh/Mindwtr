cmake_minimum_required(VERSION 3.22.1)

project(quickjs-android-wrapper LANGUAGES C CXX)

file(STRINGS "${CMAKE_CURRENT_SOURCE_DIR}/quickjs/VERSION" QUICKJS_VERSION)

add_library(
  quickjs-android-wrapper
  SHARED
  native/cpp/quickjs_context_jni.cpp
  native/cpp/quickjs_wrapper.cpp
  wrapper-android/src/main/cpp/quickjs_android.cpp
  quickjs/cutils.c
  quickjs/dtoa.c
  quickjs/libregexp.c
  quickjs/libunicode.c
  quickjs/quickjs.c
)

target_include_directories(quickjs-android-wrapper PRIVATE quickjs)

target_compile_definitions(
  quickjs-android-wrapper
  PRIVATE
  CONFIG_VERSION="${QUICKJS_VERSION}"
  _GNU_SOURCE
  JS_DEFAULT_STACK_SIZE=262144
  IS_ANDROID=TRUE
)

get_filename_component(REPO_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/../../../../.." REALPATH)

target_compile_options(
  quickjs-android-wrapper
  PRIVATE
  "-ffile-prefix-map=${REPO_ROOT}=."
  "-ffile-prefix-map=${ANDROID_NDK}=/ndk"
  "-ffile-prefix-map=${CMAKE_BINARY_DIR}=/build"
)

target_link_options(
  quickjs-android-wrapper
  PRIVATE
  "-Wl,--gc-sections"
  "-Wl,-z,max-page-size=16384"
  "-Wl,-z,common-page-size=16384"
)

target_link_libraries(quickjs-android-wrapper log)
