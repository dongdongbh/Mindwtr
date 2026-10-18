# Desktop task editor customization

The popup editor places configured Details beside the task properties on large windows and stacks them on narrow windows. Inline editing retains its existing field order. User field order, visibility, grouping, and section preferences remain active. Popup labels use a larger type size and Quick Add token hints remain available to assistive technology without visual clutter.

## Pasting images

Focus the description source editor and paste an image. The existing file importer writes an owned copy into the managed attachments directory. The draft receives a standard file attachment and a Markdown image reference using its stable ID: ![Image](mindwtr://attachment/id). The same image can be opened or removed through Attachments. Preview and the expanded editor reuse the existing AttachmentImage component.

Clipboard images use the file list, falling back to clipboard items only when that list contains no images. Reading both representations imports the same image twice on Windows WebView, where each representation can contain a different File wrapper. This rule also applies to Quick Add and preserves multiple files with matching names and sizes.

Saving, including save-on-exit and completion actions, is blocked during file import. Discard invalidates pending imports and removes only owned copies. Delayed paste completion preserves intervening typing and cannot replace a later selection or a reopened draft. Undo removes the Markdown insertion while keeping the attachment available. Deleting an attachment can leave an unresolved image reference, displayed as alt text.

Only image attachments of the current task can render inline. Remote Markdown images and protocol-relative/UNC attachment URIs remain blocked.

## Validation and limits

Desktop Vitest checks cover paste/import failure, intervening typing, undo, preview toggle, discarded/reopened editors, stale callbacks, managed-file cleanup, shared save blocking, and image URL filtering. TypeScript, ESLint and the Vite production build pass. In-app-browser checks cover rendered images, save/reload, the web import rejection, and 1487x1058 / 400x700 layouts with no horizontal overflow and a visible Save button. The screenshot uses synthetic data.

Windows release builds pass. Manual Windows acceptance confirmed image/text persistence after save/reopen, responsive controls, and the unsaved-changes prompt. It exposed duplicate clipboard imports, now covered by regression tests; the corrected native build still needs manual acceptance. Cross-device sync remains unverified. This change does not update the mobile Markdown renderer; images remain standard attachments there. Empty WebKit paste events do not use Quick Add's async clipboard fallback here. Collapsing the field during import retains the image as an attachment and skips the stale inline insertion.

## Maintaining the fork

Keep these changes as focused commits. Fetch upstream releases and merge upstream/main into the fork's main branch; resolve editor conflicts and rerun the scoped tests and a native paste/save/reopen smoke check before building an installer. Do not use upstream's automatic updater until the custom changes land upstream or a separate fork updater has been deliberately configured. This change does not reconfigure the updater.

Reverting the UI commits restores the original editor without replacing the user's database. Existing image files remain normal attachments; older Markdown renderers may omit their inline previews.
