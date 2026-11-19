# Rust audit exceptions

## RUSTSEC-2026-0543: chrono

The [RustSec advisory](https://rustsec.org/advisories/RUSTSEC-2026-0543) classifies every chrono version as unmaintained and provides no patched version. This is a maintenance warning, not a reported exploit. Mindwtr uses chrono 0.4.42 only through the existing imap 2.4.1 dependency; application code does not import it directly.

The dependency audit permits this advisory while asserting that exact immediate dependency tree. Any version change or additional consumer fails the guard and requires review. Remove the exception when the IMAP dependency no longer requires chrono. Replacing the IMAP implementation is separate work and must preserve email capture behavior.
