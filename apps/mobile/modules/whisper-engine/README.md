# Standalone Whisper engine gate

This package uses the locked `whisper.rn@0.5.4` public C engine without React,
Expo, JSI or copied RN context wrappers. It does not enable a speech provider.

Prepare from an already installed package; no download occurs:

```sh
python3 scripts/prepare_vendor.py /path/to/installed/whisper.rn
python3 scripts/test_prepare_vendor.py
```

Preparation verifies the pinned device/simulator binary, C header and shader
hashes, copies the complete framework and MIT license into ignored `Vendor/`,
adds a C-only module map, and records complete input/output hashes in
`Vendor/provenance.json`. An exact second run verifies reuse. Any existing
changed/unowned Vendor is refused intact. The script never replaces it.
Vendor paths in Package.swift are relative; installed package paths are not
embedded in build files or provenance.

```swift
let engine: WhisperEngine
do {
    let descriptor = try await modelLease.duplicateDescriptor()
    defer { Darwin.close(descriptor) }
    engine = try await WhisperEngine.open(modelDescriptor: descriptor)
}
let text = try await engine.transcribe(samples: mono16kFloatPCM, language: "en")
await engine.close()
```

Initialization, decoding and free run on a private serial worker. Each call
has its own cancellation flag; cancellation cannot stop a later call. Close
waits behind active work and is idempotent. Samples must be finite, within
[-1, 1], nonempty and at most 120 seconds at 16 kHz. The owning app must supply
normalized language and verified model/audio leases before exposing this API.
This first gate does not validate model installation/file authority.

The descriptor overload duplicates the caller's open file and uses `pread`
without changing its offset or reopening its name. Keep the model lease until
the engine closes. Initialization drains before cancellation returns because
the pinned C loader cannot safely consume cancellation-induced short reads.
The URL overload remains available for trusted standalone fixtures.

The framework has iOS device/simulator slices, no macOS slice. Other platforms
report unavailable; this is not a macOS inference implementation. Root owns
Apple SDK import/link, framework embedding/re-signing and shader lookup gates.
Keep the whole framework, including its bundled Metal shader. The prepared
MIT notice must accompany distribution.

XCTest includes pure input/cancellation checks and a real-engine smoke test.
Root supplies the ignored fixtures described in `Tests/.../Fixtures/README.md`;
missing fixtures fail explicitly and never count as successful inference.
