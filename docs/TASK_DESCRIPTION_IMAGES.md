# Desktop description clipboard images

Pasting an image into a task description imports a managed file attachment and inserts a stable Markdown reference, `![Image](mindwtr://attachment/id)`. Preview, expanded editor and saved task display resolve only live image attachments belonging to that task. Remote images and protocol-relative/UNC sources remain blocked.

The source editor remains Markdown. Removing an inline reference or undoing its insertion retains the attachment. Removing the attachment can leave alt text in the description.

Pending imports block all save paths and count as unsaved changes. Discard invalidates imports and removes only owned copies. Delayed completion preserves intervening typing and cannot change a reopened draft. Collapsing Details during import keeps the attachment and skips the stale inline insertion.

Clipboard file and item lists are alternate representations, not separate files. Use images from files and fall back to items only when there are none. Regression tests model distinct File wrappers to prevent doubled imports, including Quick Add; multiple files with matching metadata are retained.

Tests cover deferred callbacks, cancellation, cleanup, save guards, safe image resolution and duplicate clipboard representations. Manual Windows acceptance of the downstream combined build confirmed paste, save/reopen persistence and the duplicate-import correction. This separate feature diff needs its own native and cross-device review. Mobile inline rendering is unchanged; attachments remain available there. Empty WebKit paste events do not use Quick Add's async clipboard fallback in the description editor.

No new dependency, storage schema, popup layout or presentation setting is added here.
