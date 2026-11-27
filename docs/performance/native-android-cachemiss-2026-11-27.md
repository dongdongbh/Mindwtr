# Native Android first start after an install or update, 2026-11-27

Task native-cachemiss-start-20261127-102. Follow-up to the [5k boot pass](native-android-boot-5k-2026-11-16.md), which found
that the first start after an install pays about 600 ms to parse the bundle. Raw files: `/home/dd/scratch/logs/native-cachemiss-start/`.

## Result

**First start after an install, empty library: first content 873.5 → 291 ms (median, n = 8 per arm). At 5k: 1538.5 → 943 ms.**
The APK now carries the bundle already compiled to QuickJS bytecode. The phone reads that file instead of parsing 10.8 MB of
JavaScript. On every measured install, the bytecode the phone compiled for itself afterwards was byte-identical to the shipped
file (16 of 16). The APK grows by **3.66 MB** (25.67 → 29.33 MB).

## How it works

- **Build:** Gradle builds a small host program, `apps/android-native/scripts/compile-bytecode.c`, from the same vendored QuickJS
  sources and defines the app uses. It compiles `core-host.js` the way the app's wrapper does: `JS_STRIP_SOURCE`, global script,
  file name `core-host.js`, `JS_WRITE_OBJ_BYTECODE | JS_WRITE_OBJ_REFERENCE`. It first turns the bundle into JNI modified UTF-8,
  because that is what the app's compile call receives. `build-bytecode.mjs` wraps the result in the same container the device
  cache uses (magic, bundle SHA-256, engine `quickjs-<VERSION>`, length, SHA-256 of the bytecode). The file ships as the asset
  `core-host.qjsc`.
- **Start:** the device cache in `code_cache` is still read first. Android deletes it on every install or update, so the first start
  then reads the shipped asset through the same key check: the bundle hash, the engine name, the length and the checksum must all
  match, or the asset is not used. If the engine rejects the bytes, the app makes a fresh context and parses the source (the path
  that already existed for the device cache).
- **Check on the phone:** after first content, the app still compiles the bundle in the background and writes its own cache, as
  before. It now also compares the SHA-256 of its compile with the checksum the shipped file carried (kept from the start, so the
  asset is not read again) and logs the result (`v1.3.10/android-shipped-bytecode`,
  `outcome=match|mismatch`, `load=shipped`). From the second start on, the app runs its own compile, so a mismatch can affect only
  the first start.

## Why the shipped bytecode is safe to run

- **Format:** QuickJS writes bytecode in a fixed little-endian layout. It writes atoms as strings and BigInts as minimal
  two's-complement bytes. Pointer size does not enter the file.
- **Host check:** the host program built for 64-bit and for 32-bit (`-m32`) wrote byte-identical bytecode for this bundle
  (`128dfc7e…b975`).
- **Phone check:** the S23 (arm64) compiled byte-identical bytecode on all 16 candidate installs (`outcome=match`).
- **Guards with tests:** `BytecodeCacheTest` covers the shipped path with a wrong engine, a wrong bundle hash, a flipped byte, a
  damaged header, short and long files, and a missing asset. A golden container file is checked by both writers: the Kotlin cache
  (`BytecodeCacheTest`) and the build script (`build-bytecode.test.mjs`). Boot gates pin the read order and keep the host
  program in step with the app engine: the CMake defines (plus Release `NDEBUG`) must equal the host `-D` flags, the source lists
  must match, QuickJS must never read `IS_ANDROID`, and the strip, eval and write flags must equal the wrapper's. Eight one-line
  edits to either side (a new define, a changed stack size, a new source, other strip, eval or write flags, an `IS_ANDROID` read)
  each turned the gate red.
- **Fallback on the phone:** two mutant APKs (the candidate with its asset replaced, then re-signed with the same debug key):
  - one flipped byte, old checksum: the asset was refused (`unused-corrupt`), the source was parsed, first content 1021 ms;
  - half the bytecode, recomputed checksum: the engine threw, the app parsed the source (`load=failed:QuickJSException`), first
    content 925 ms.
  Both then started from their own cache (233 and 234 ms).

## Setup

- Galaxy S23 `RFCW10JBP0Y`, Android 16. Benchmark builds only (`tech.dongdongbh.mindwtr.nativeclient.dev.benchmark` and its seed
  twin). ART at `verify`. Thermal status 0; battery 26–33 °C. The batch held `gates.lock` and `s23.lock`; load 3.0 at the start.
- Base `76dc0b273`. Both arms carry the same bundle (`25784a61…9be9`). APKs and SHA-256 sums in `apks/<tag>/SHA256SUMS`:
  - `control`: the base, Benchmark APK `7729af3d…88ce`, 25,667,060 bytes.
  - `cand`: the base plus this change, Benchmark APK `a50f0d19…be75`, 29,329,083 bytes. Asset `core-host.qjsc` 9,528,157 bytes,
    stored deflated at 3,661,907.
  - `corrupt` `d4bd1e62…f7fe` and `truncated` `cc025e43…d341`: fallback checks only.
- Fixtures: `empty`, and `large-5000` (`9cae3bf1…287c`).
- Cache-miss A/B (`missab.sh`): per round, each arm (order flips every round) is uninstalled, seeded and set to ART `verify`. Then
  it runs a first cold start (no device cache), waits 8 s, and runs one more cold start (device cache hit). 8 rounds per fixture.
- Traces (`tracemiss.sh`): one Perfetto trace of a first start per arm and fixture, `traces/miss/`.

## A/B: first content, ms

| Fixture | Start | control median | cand median | control min–max | cand min–max |
| --- | --- | ---: | ---: | ---: | ---: |
| empty | first after install | 873.5 | **291** | 843–908 | 276–299 |
| large-5000 | first after install | 1538.5 | **943** | 1499–1574 | 930–988 |
| empty | second (device cache) | 237 | 238.5 | 228–244 | 230–259 |
| large-5000 | second (device cache) | 525.5 | 536.5 | 516–548 | 515–553 |

Every candidate first start ran the shipped bytecode (`load=shipped`). Every second start in both arms ran the device cache.

At 5k the second start reads 11 ms slower on `cand` (n = 8). A dedicated cache-hit A/B (`ab.sh`, as on 11-16: per round a
fresh install, one first start, then 1 discard and 5 cold samples, order flipped each round; 06:45–06:52, load 2.9) shows no
difference. Every sample ran from the device cache (`outcome=hit`):

| Fixture | Arm | n | Median | p90 | min–max |
| --- | --- | ---: | ---: | ---: | ---: |
| large-5000 | control | 20 | 527 | 563 | 516–611 |
| large-5000 | cand | 20 | 527 | 547 | 514–551 |
| empty | control | 10 | 229 | 241 | 226–252 |
| empty | cand | 10 | 230 | 252 | 224–263 |

A start from the device cache runs the same code as before; it never opens the shipped asset.

## Where the first start goes now (one trace each, ms)

| Phase | control, empty | cand, empty | cand, 5k |
| --- | ---: | ---: | ---: |
| `boot:shippedBytecode` (read and check the asset) | — | 51.5 | 64.1 |
| `core:evaluate` | 693.3 | 48.2 | 55.7 |
| first content (`Fully drawn`) | 911 | 329 | 979 |

The shipped path costs about 100–120 ms before `core:boot`, against about 65–93 ms from the device cache. The extra is the asset
read: the 3.66 MB deflated asset is inflated to 9.5 MB, copied, and checksummed. At 5k the first start also pays the one-time
migration save of a never-opened fixture (`js:activate` 592 ms, as on 11-16); an update over a library the app has opened does not.

## Limits

- One phone (arm64). The 32-bit and x86 ABIs ship the same file; only the host `-m32` build checked 32-bit pointers. A device
  of another ABI that compiles differently would log `mismatch`, then use its own compile from the second start.
- n = 8 per cell for the cache-miss A/B, one trace per cell.
- The build now needs a host C compiler (`cc`) next to the NDK. Gradle caches the compiler binary; it rebuilds only when the QuickJS
  sources change (about 30 s).
- The background compile after the first start still runs (about 600 ms of CPU at background priority), as it did before this
  change. It is what proves the shipped bytes on each phone.

## Next

- **The asset read, 51–64 ms.** Storing the asset uncompressed (`noCompress`) and reading it without the extra copy would cut most of
  it, at about 5.9 MB more APK. Measure before choosing.
- **The load normalizer at 5k** (88.6 ms) stays the next cold-start lead from the 11-16 report.
