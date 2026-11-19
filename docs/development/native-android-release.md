# Native Android release candidates

This page explains how the release workflows build Android while the native Kotlin app is in release candidate (RC) testing. The plan and its rules live in [Native mobile migration](native-mobile-migration.md). This page covers the workflow details.

## Which client each workflow builds

- **RC tags (`release-rc.yml`) always build the native app.** The workflow passes `android_client: native` to `release-android.yml` and `release-android-foss.yml`.
- **Stable tags (`release.yml`) always build the React Native (RN) app.** They pass no `android_client`, so both reusable workflows use their default, `rn`.
- **A manual run of `release-android.yml` or `release-android-foss.yml` builds RN.** These dispatch forms have no client input.

A native RC makes three files:

| File | Gradle task | ABIs | Signing key | Where it goes |
| --- | --- | --- | --- | --- |
| `mindwtr-<version>.aab` | `:app:bundlePlayRelease` | arm64-v8a, armeabi-v7a | EAS upload key | Play internal and beta |
| `mindwtr-<version>.apk` | `:app:assemblePlayRelease` | arm64-v8a, armeabi-v7a | EAS upload key | GitHub prerelease |
| `mindwtr-<version>-foss.apk` | `:app:assembleFossRelease` | arm64-v8a | Maintainer release key | GitHub prerelease |

An ABI (application binary interface) is a processor type that a native library is built for. The sets match what RN ships today.

`scripts/ci/build-android-native-release.sh <aab|apk|foss> <output-dir>` builds and checks each file. It runs Gradle in `apps/android-native/android`, then checks:

- the signer certificate SHA-256 equals `EXPECTED_SIGNER_SHA256` (the workflow sets the known EAS or maintainer certificate);
- the APK package name, versionCode, and versionName (with `aapt2 dump badging`);
- 16 KB alignment of the 64-bit native libraries;
- for FOSS, that no Google Play library class is in the APK.

The Play AAB and the GitHub APK need different diagnostic heartbeat channels. So the workflow runs Gradle twice in one job. The second run reuses the first run's compiled outputs.

## Gradle inputs

The release build type reads these values. Each has a safe local default.

| Input | Kind | Default |
| --- | --- | --- |
| `mindwtr.versionCode` | Gradle property | `expo.android.versionCode` in `apps/mobile/app.json` |
| `mindwtr.versionName` | Gradle property | `expo.version` in `apps/mobile/app.json` |
| `mindwtr.abis` | Gradle property, comma list | every ABI |
| `MINDWTR_RELEASE_KEYSTORE`, `MINDWTR_RELEASE_STORE_PASSWORD`, `MINDWTR_RELEASE_KEY_ALIAS`, `MINDWTR_RELEASE_KEY_PASSWORD` | environment | unset: the release build is unsigned |

The native versionName is the full RC version, for example `1.4.0-rc.1`. The About screen keeps `RN_VERSION` (`1.4.0`) and `RN_RELEASE_VERSION` (the tag).

## Version codes

`scripts/ci/android-version-code-policy.js` computes every Android versionCode. `ANDROID_CLIENT` selects the rule. `NATIVE_RC_LEAD` (15) is defined only in that file.

- **Native RC:** the larger of (highest RN code + 15) and (highest code on any Play track + 1). The highest RN code also counts the tracked `app.json` code. So rc.1 starts 15 above RN, and each later RC goes up by at least 1.
- **RN stable:** the tracked `app.json` code. It must be above every RN code on Play and below the newest native RC code on Play. When it would reach the RC code, the workflow fails and asks for a new native RC first. Play gives a tester the highest code they are eligible for, so this keeps RC testers on native.
- **One code per release.** The Play AAB, the GitHub APK, and the FOSS APK of one release share the code.

The policy reads the Play track releases from `google-play-edit.py max-version-code`. It sorts each release like this:

1. A release on `production` is RN.
2. A release named `<version> native testing` on a testing track is a native RC. Only native RC publication uses this name.
3. A release with a name the RN workflows have used is RN: a bare `<version>`, `<version> testing` (any version, for example `1.3.9-beta.1 testing`), `<version> stable <track>`, `<version> release candidate`, `<version> internal diagnostic <n>`, and `<version> (internal)`.
4. Any other release is ignored when all its codes are at or below the highest production code. A release with no name and no codes is ignored too.
5. Any other release above production stops the workflow. The policy never guesses whether it is native. Rename or replace that release in Play Console.

An RC dispatch with `run_play_testing` off cannot read the codes from Play. It fails unless you give `android_version_code`.

**After v1.3.9, RN stable releases publish to Play production only.** v1.3.9 is the final RN release shared with open and internal testing. Native testing begins at v1.4.0. Replacing those native RCs with a later RN stable release would remove the native RC from every track, and the policy could no longer see its code. The release planner rejects RN testing versions above 1.3.9 and native testing versions below 1.4.0.

`scripts/bump-version.sh` with `ANDROID_REMOTE_MAX_VERSION_CODE` treats that number as an RN code. Pass the highest production code, not a native RC code.

## Secrets

| Secret | Used for |
| --- | --- |
| `ANDROID_UPLOAD_KEYSTORE_BASE64` | EAS upload keystore, base64 |
| `ANDROID_UPLOAD_KEY_ALIAS` | its key alias |
| `ANDROID_UPLOAD_STORE_PASSWORD` | its keystore password |
| `ANDROID_UPLOAD_KEY_PASSWORD` | its key password |
| `ANDROID_RELEASE_KEYSTORE_BASE64`, `ANDROID_RELEASE_KEY_ALIAS`, `ANDROID_RELEASE_STORE_PASSWORD`, `ANDROID_RELEASE_KEY_PASSWORD` | maintainer FOSS key, the same secrets the RN FOSS build uses |

The `validate` job of `release-rc.yml` checks all eight secrets. When one is missing, the RC stops before any platform builds or publishes.

`eas-cli` 21.5.0 cannot download the keystore without prompts. Export it once by hand:

1. Run `tools/eas-cli/node_modules/.bin/eas credentials -p android` in `apps/mobile`.
2. Choose the `production` build profile.
3. Choose **Keystore: Manage everything needed to build your project**, then **Download existing keystore**.
4. Note the keystore password, key alias, and key password that it prints. It saves a `.jks` file in the current folder.
5. Check the certificate: `keytool -list -v -keystore <file>.jks` must show SHA256 `09:90:2A:7F:33:AE:C0:74:A1:FA:56:42:EF:36:0F:34:9D:AE:6E:8B:67:38:7D:36:B5:23:F9:66:A3:22:0E:F8`.
6. Run `base64 -w0 <file>.jks | gh secret set ANDROID_UPLOAD_KEYSTORE_BASE64`.
7. Run `gh secret set` for `ANDROID_UPLOAD_KEY_ALIAS`, `ANDROID_UPLOAD_STORE_PASSWORD`, and `ANDROID_UPLOAD_KEY_PASSWORD`.
8. Delete the `.jks` file.

## Build a release locally

Use a throwaway keystore. Never use a real key on a workstation.

```sh
node apps/android-native/scripts/build-bundle.mjs
RELEASE_VERSION=1.4.0-rc.1 RELEASE_VERSION_CODE=175 \
  EXPECTED_SIGNER_SHA256=<throwaway certificate SHA-256> \
  SIGNING_KEYSTORE_BASE64="$(base64 -w0 throwaway.jks)" SIGNING_KEY_ALIAS=<alias> \
  SIGNING_STORE_PASSWORD=<password> SIGNING_KEY_PASSWORD=<password> \
  bash scripts/ci/build-android-native-release.sh apk out
```

## Update checks in a native RC

A native RC build sets `releaseCandidateUpdates` in its About app info when its release version contains `-rc.`. Its GitHub update check then reads the release list, not `releases/latest`. It offers only a newer RC prerelease (for example `1.4.0-rc.2` over `1.4.0-rc.1`). It never offers a stable release, because a stable release is RN until native goes stable, and an RN APK has a lower versionCode and cannot install over the RC. The same rule applies when the Play check fails and the app falls back to GitHub. A Play install still asks Play, which offers only higher versionCodes.

**When native goes stable, change this rule** so that the RC line also offers native stable releases.

## Play Console declarations

We compared the merged manifest of the native Play build (`1.4.0-rc.1`, local build) with the RN `mindwtr-1.3.8.apk` from the GitHub release. The GitHub APK and the Play AAB share one manifest in both apps. We used `aapt2 dump permissions` and `aapt2 dump xmltree`.

- **New permission:** `com.google.android.finsky.permission.BIND_GET_INSTALL_REFERRER_SERVICE`. It is a normal permission that the Play Install Referrer library adds. It needs no Play Console declaration. The FOSS APK does not have it.
- **No other permission changes.** Both builds request the same 16 other permissions, including `SCHEDULE_EXACT_ALARM`, `READ_CALENDAR`, `WRITE_CALENDAR`, `RECORD_AUDIO`, `POST_NOTIFICATIONS`, and `FOREGROUND_SERVICE`. Their existing declarations stay valid.
- **No new foreground service types.** The native app declares no `foregroundServiceType`. RN declares `mediaPlayback` (`expo.modules.audio.service.AudioControlsService`) and `microphone` (`expo.modules.audio.service.AudioRecordingService`). Nothing new needs a declaration. The existing foreground service declaration in Play Console describes features the native app does not use; update it when native goes stable.
- **Target SDK:** 36 in both.
