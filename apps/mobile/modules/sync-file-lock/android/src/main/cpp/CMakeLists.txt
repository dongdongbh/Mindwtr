cmake_minimum_required(VERSION 3.22.1)

project(sync_file_lock LANGUAGES CXX)

add_library(
  sync-file-lock
  SHARED
  file_compat_lock.cpp
  stable_root_lock.cpp
)

get_filename_component(REPO_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/../../../../../../../.." REALPATH)

target_compile_options(
  sync-file-lock
  PRIVATE
  "-ffile-prefix-map=${REPO_ROOT}=."
  "-ffile-prefix-map=${ANDROID_NDK}=/ndk"
  "-ffile-prefix-map=${CMAKE_BINARY_DIR}=/build"
)

target_link_options(
  sync-file-lock
  PRIVATE
  "-Wl,-z,max-page-size=16384"
  "-Wl,-z,common-page-size=16384"
)
