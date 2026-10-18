# Desktop popup task editor layout

The existing Pop-up presentation uses two columns on wide windows: configured Details beside task properties. Narrow windows stack those columns with Details first. The existing In-row presentation keeps its field order; this adds no third presentation setting.

Details moves as one configured section. Field visibility, ordering, grouping, disclosure, draft handling, attachments and storage remain owned by the existing components. The Calendar task dialog explicitly requests inline presentation and retains it; this is not a Calendar redesign.

The title and persistent action row receive popup-specific spacing. The form owns scrolling so Save/Cancel remain accessible. Existing native controls, shortcuts, and file-drop routing are retained.

Layout tests cover modal columns, inline order, and moving configured Details together.

On 2026-10-18, the owner explicitly reported that all four requested native smoke cases passed in the main installed Windows application, built from downstream commit `cbbc3ac5b5c7f536502eee32fcc7904856ba4f07`:

- Save and Cancel remain accessible in a short window.
- Project and date pickers remain usable near scroll edges.
- Resizing preserves an unsaved description draft.
- Dropping a file reveals Attachments assigned to a different configured section.

This is owner-reported manual acceptance of the combined layout-and-images build, not an automated native test or a separate native run of the layout-only PR head. Earlier manual acceptance also covered save/reopen behavior. Upstream review and CI remain separate merge requirements.

Clipboard image import and inline Markdown image rendering are proposed separately. They are not part of this layout diff.
