# Attachments (Files, Links, Audio)

Mindwtr lets you attach files and links to **tasks** and **projects**. Attachments are optional and sync across devices when sync is enabled.

---

## What you can attach

- **Files** (PDFs, images, docs, etc.)
- **Links** (URLs, web pages, reference links)
- **Audio notes** (when "Save audio attachments" is enabled)

---

## Add attachments

### Desktop

- Open a task or project.
- In **Attachments**, click **Add file** or **Add link**.
- For links, paste a URL or local file path.

### Mobile

- Open a task.
- Use **Add attachment** to pick a file or add a link.
- Audio notes are added automatically if you record voice capture and **Save audio attachments** is enabled.

---

## Audio attachments

When you enable **Save audio attachments** (Settings → General), Mindwtr keeps the original voice note alongside the transcript. This is useful if you want to replay or share the recording later.

### Linux audio playback dependencies

Audio playback on Linux uses **GStreamer**. If you see errors like `autoaudiosink not found`, install the GStreamer plugins:

**Arch / Manjaro**
```bash
sudo pacman -S gstreamer gst-plugins-base gst-plugins-good gst-plugins-bad gst-plugins-ugly gst-libav
```

**Debian / Ubuntu / Mint**
```bash
sudo apt install gstreamer1.0-plugins-base gstreamer1.0-plugins-good gstreamer1.0-plugins-bad gstreamer1.0-plugins-ugly gstreamer1.0-libav
```

**Fedora** (RPM Fusion required for some codecs)
```bash
sudo dnf install gstreamer1-plugins-base gstreamer1-plugins-good gstreamer1-plugins-bad-free gstreamer1-plugins-ugly gstreamer1-libav
```

## Sync behavior

- Attachment metadata syncs with tasks/projects.
- Actual files sync after metadata.
- If a file is missing locally, the attachment stays visible and can be re-downloaded when available.

> Tip: Large files can slow sync. Prefer smaller attachments or links when possible.

---

## Cleanup

Mindwtr automatically cleans up **orphaned attachments** (files no longer referenced by any task/project).

- Desktop: You can also run cleanup manually in **Settings → Data → Attachment cleanup**.
- Mobile: Cleanup runs automatically during sync.

---

## Related

- [[Data and Sync]]
- [[User Guide Desktop]]
- [[User Guide Mobile]]
