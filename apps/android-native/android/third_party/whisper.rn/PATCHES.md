# Vendored whisper.cpp (from whisper.rn)

This folder holds the speech-to-text engine that the `:whisper` module builds from source. The RN app runs the same engine through the `whisper.rn` npm package. Native Android builds it here, so F-Droid can build it with the app's NDK.

## Source

| Folder | Upstream | Revision | License |
| --- | --- | --- | --- |
| `cpp` | npm package `whisper.rn` (https://github.com/mybigday/whisper.rn), folder `cpp` | `0.5.4`, the version in `bun.lock` (`package.json` SHA-256 `5ff1a12a4d7426dbe61f20c40a8292336f375f30ee79fd5d023d96e22562ecc7`). It bundles whisper.cpp `1.8.0` with ggml symbols renamed to `wsp_ggml`. | MIT: `LICENSE` (whisper.rn, Jhen-Jie Hong) and `LICENSE.whisper.cpp` (whisper.cpp and ggml, The ggml authors) |

- `cpp` holds every file of the package's `cpp` folder except four groups the Android build never compiles: `coreml/` and `ggml-metal/` (Apple only), `jsi/` (the React Native binding) and the `rn-*` files (whisper.rn's job and audio helpers).
- The files are byte-identical to the package. `SHA256SUMS` lists them. Check them with `cd cpp && sha256sum -c ../SHA256SUMS`.
- `LICENSE` is the package's own file. The package carries no whisper.cpp license file, so `LICENSE.whisper.cpp` holds the MIT text of https://github.com/ggml-org/whisper.cpp/blob/master/LICENSE.

## Local patches

None.

## Build settings (in `apps/android-native/android/whisper`)

- NDK 27.1.12297006, the app's NDK. `CMAKE_BUILD_TYPE=Release` for every variant, so a debug build runs the same optimized engine.
- The compile definitions and CPU flags follow whisper.rn's `android/src/main/CMakeLists.txt`: `WSP_GGML_USE_CPU`, `WSP_GGML_USE_CPU_REPACK`, the `arch/arm` or `arch/x86` kernels, and one library per CPU level.
  - arm64-v8a: `libmindwtr_whisper.so` (`-march=armv8-a`) and `libmindwtr_whisper_fp16.so` (`-march=armv8.2-a+fp16`). The app loads the second one when `/proc/cpuinfo` lists `fphp` or `fp16`, as whisper.rn does.
  - armeabi-v7a: `-mfpu=neon-vfpv4`. x86_64: `-march=x86-64 -msse4.2 -mpopcnt`. x86: the generic C kernels (`WSP_GGML_CPU_GENERIC`); whisper.rn ships no x86 library.
- CPU only. No GPU, Core ML or Vulkan backend.
- 16 KB page alignment, and the repo, NDK and build paths are mapped out of the debug info, as for QuickJS.
