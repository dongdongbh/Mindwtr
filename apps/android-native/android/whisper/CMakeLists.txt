cmake_minimum_required(VERSION 3.22.1)

project(mindwtr-whisper LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(WHISPER_CPP "${CMAKE_CURRENT_SOURCE_DIR}/../third_party/whisper.rn/cpp")
get_filename_component(REPO_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/../../../.." REALPATH)

set(
  WHISPER_SOURCES
  ${WHISPER_CPP}/ggml.c
  ${WHISPER_CPP}/ggml-alloc.c
  ${WHISPER_CPP}/ggml-backend.cpp
  ${WHISPER_CPP}/ggml-backend-reg.cpp
  ${WHISPER_CPP}/ggml-cpu/amx/amx.cpp
  ${WHISPER_CPP}/ggml-cpu/amx/mmq.cpp
  ${WHISPER_CPP}/ggml-cpu/ggml-cpu.c
  ${WHISPER_CPP}/ggml-cpu/ggml-cpu.cpp
  ${WHISPER_CPP}/ggml-cpu/quants.c
  ${WHISPER_CPP}/ggml-cpu/traits.cpp
  ${WHISPER_CPP}/ggml-cpu/repack.cpp
  ${WHISPER_CPP}/ggml-cpu/unary-ops.cpp
  ${WHISPER_CPP}/ggml-cpu/binary-ops.cpp
  ${WHISPER_CPP}/ggml-cpu/vec.cpp
  ${WHISPER_CPP}/ggml-cpu/ops.cpp
  ${WHISPER_CPP}/ggml-opt.cpp
  ${WHISPER_CPP}/ggml-threading.cpp
  ${WHISPER_CPP}/ggml-quants.c
  ${WHISPER_CPP}/gguf.cpp
  ${WHISPER_CPP}/whisper.cpp
  src/main/cpp/whisper_jni.cpp
)

function(whisper_library name arch)
  add_library(${name} SHARED ${WHISPER_SOURCES})
  if(arch STREQUAL "generic")
    target_compile_definitions(${name} PRIVATE WSP_GGML_CPU_GENERIC)
  else()
    target_sources(${name} PRIVATE ${WHISPER_CPP}/ggml-cpu/arch/${arch}/quants.c ${WHISPER_CPP}/ggml-cpu/arch/${arch}/repack.cpp)
  endif()
  target_include_directories(${name} PRIVATE ${WHISPER_CPP} ${WHISPER_CPP}/ggml-cpu)
  target_compile_definitions(${name} PRIVATE WSP_GGML_USE_CPU WSP_GGML_USE_CPU_REPACK)
  target_compile_options(
    ${name}
    PRIVATE
    -pthread
    -fvisibility=hidden
    -fvisibility-inlines-hidden
    -ffunction-sections
    -fdata-sections
    "-ffile-prefix-map=${REPO_ROOT}=."
    "-ffile-prefix-map=${ANDROID_NDK}=/ndk"
    "-ffile-prefix-map=${CMAKE_BINARY_DIR}=/build"
    ${ARGN}
  )
  target_link_options(
    ${name}
    PRIVATE
    "-Wl,--gc-sections"
    "-Wl,--exclude-libs,ALL"
    "-Wl,-z,max-page-size=16384"
    "-Wl,-z,common-page-size=16384"
  )
  target_link_libraries(${name} log)
endfunction()

if(ANDROID_ABI STREQUAL "arm64-v8a")
  whisper_library(mindwtr_whisper arm -march=armv8-a)
  whisper_library(mindwtr_whisper_fp16 arm -march=armv8.2-a+fp16)
elseif(ANDROID_ABI STREQUAL "armeabi-v7a")
  whisper_library(mindwtr_whisper arm -mfpu=neon-vfpv4)
elseif(ANDROID_ABI STREQUAL "x86_64")
  whisper_library(mindwtr_whisper x86 -march=x86-64 -msse4.2 -mpopcnt)
else()
  whisper_library(mindwtr_whisper generic)
endif()
