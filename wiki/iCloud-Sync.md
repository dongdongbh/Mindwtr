# iCloud Sync

Mindwtr supports a native **iCloud / CloudKit** sync backend for Apple devices where the native module is available.

## Availability

- **iPhone / iPad:** supported through the native `iCloud` sync backend in **Settings → Data & Sync**
- **Android:** not supported
- **Windows / Linux:** not supported
- **macOS desktop:** supported through the native `iCloud` sync backend in **Settings → Data & Sync**

## What It Syncs

The native iCloud backend syncs the same core GTD data as the other structured backends:

- tasks
- projects
- sections
- areas
- synced settings groups

It uses CloudKit in your Apple account rather than a user-selected `data.json` folder.

## Setup

1. Sign in to the same Apple ID on the devices you want to sync.
2. Make sure iCloud is enabled for Mindwtr on those devices.
3. In Mindwtr on your Apple device, open **Settings → Data & Sync**.
4. Choose **iCloud** as the sync backend.
5. Run a sync once to seed or pull your data.

After setup, Mindwtr keeps using the normal local-first merge flow and can react to CloudKit change notifications when available.

## Platform Notes

- If a non-Apple build sees an old `cloudkit` backend value, Mindwtr falls back to `Off` instead of showing a broken iCloud option.
- macOS users can still use **iCloud Drive + File Sync** if they prefer a folder-based workflow over the native CloudKit backend.
- If you need a cross-platform backend between Apple and non-Apple devices, use **WebDAV**, **Mindwtr Cloud**, **Dropbox** (supported builds), or **File Sync**.

## When To Use It

Use native iCloud sync when:

- all participating devices are in the Apple ecosystem
- you want a simpler setup than picking and maintaining a shared folder
- you do not need Android / Windows / Linux clients in the same sync mesh

If you need mixed-platform sync, see [[Data and Sync]].
