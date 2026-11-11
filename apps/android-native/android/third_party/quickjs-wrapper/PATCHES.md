# Vendored QuickJS wrapper

This folder builds the app's JavaScript engine from source. It replaces the Maven artifact `wang.harlon.quickjs:wrapper-android:3.2.0`.

## Sources

| Folder | Upstream | Revision | License |
| --- | --- | --- | --- |
| `native/cpp`, `wrapper-java`, `wrapper-android` | https://github.com/HarlonWang/quickjs-wrapper | tag `3.2.0`, commit `05691fb512a3f9cc7fb4d57d3a47e6d43ddf89ff` | Apache-2.0 (`LICENSE`) |
| `quickjs` | https://github.com/bellard/quickjs | commit `3d5e064e9dd67c70f7962836505a7fa067bf0a4e` ("new release", 2026-06-04), `VERSION` 2026-06-04 | MIT (`quickjs/LICENSE`) |

- `quickjs` holds only the files the library needs: `cutils`, `dtoa`, `libregexp`, `libunicode`, `list.h`, `quickjs*`, plus `LICENSE`, `VERSION` and `Changelog`. The files are unchanged.
- From the wrapper, this folder holds the JNI sources, the Java API (`com.whl.quickjs.wrapper`, `com.whl.quickjs.android.QuickJSLoader`) and `consumer-rules.pro`. The wrapper's test assets and sample app are left out.
- Wrapper 3.2.3 (the latest tag) differs from 3.2.0 in one line of library source: it turns a Java `null` into JS `null` instead of `undefined`. That would change what every bridge callback returns to the bundle. So this folder keeps 3.2.0.

## Local patches

1. `native/cpp/quickjs_context_jni.cpp`: removed `Java_com_whl_quickjs_wrapper_QuickJSContext_dumpObjects`. It called `JS_DumpObjects`, a debug function that only the wrapper's QuickJS fork has.
2. `wrapper-java/.../QuickJSContext.java`: removed the matching `dumpObjects` methods and native declaration.
3. `native/cpp/quickjs_context_jni.cpp` (`createRuntime`): added `JS_SetStripInfo(rt, JS_STRIP_SOURCE)`. Bytecode then keeps no function source text, as the old engine's bytecode did. Without it, the bytecode cache grows from 8 MB to 32 MB. Line numbers stay in error stacks.
4. `native/cpp/quickjs_wrapper.cpp` (`toJavaObject`): `JS_TAG_SHORT_BIG_INT` takes the `JS_TAG_BIG_INT` branch. The new engine stores small BigInts under the new tag. Without the patch, they reach Java as `null`.

## Build settings (in `CMakeLists.txt` and `build.gradle.kts`)

- NDK 27.1.12297006, the app's NDK. ABIs: arm64-v8a, armeabi-v7a, x86, x86_64, the same set as the 3.2.0 AAR.
- `CMAKE_BUILD_TYPE=Release` for every variant: `-O3 -DNDEBUG` plus the NDK defaults. So debug builds run the same optimized engine as the 3.2.0 AAR did.
- `JS_DEFAULT_STACK_SIZE=262144`: keeps the old engine's 256 KB stack limit. The new engine's default is 1 MB, close to the size of a Java thread's whole stack.
- `CONFIG_VERSION` comes from `quickjs/VERSION`. `CONFIG_BIGNUM` is gone, because upstream removed the bignum extensions.
- 16 KB page alignment (`-z max-page-size=16384`), as in wrapper 3.2.0.

The app keys its bytecode cache on `quickjs/VERSION` (`BuildConfig.QUICKJS_ENGINE`). Updating `quickjs` to a release with a new `VERSION` makes every phone rebuild its cache once.
