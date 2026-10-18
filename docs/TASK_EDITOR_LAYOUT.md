# Desktop popup task editor layout

The existing Pop-up presentation uses two columns on wide windows: configured Details beside task properties. Narrow windows stack those columns with Details first. The existing In-row presentation keeps its field order; this adds no third presentation setting.

Details moves as one configured section. Field visibility, ordering, grouping, disclosure, draft handling, attachments and storage remain owned by the existing components. The Calendar task dialog explicitly requests inline presentation and retains it; this is not a Calendar redesign.

The title and persistent action row receive popup-specific spacing. The form owns scrolling so Save/Cancel remain accessible. Existing native controls, shortcuts, and file-drop routing are retained.

Layout tests cover modal columns, inline order, and moving configured Details together. Native Windows manual acceptance confirmed narrow-window controls and save/reopen behavior in the combined downstream build. That is not proof for every native picker/drop boundary: short-window controls, pickers near scroll edges, unsaved-draft resizing and drops revealing configured Attachments require explicit native smoke coverage before upstream merge.

Clipboard image import and inline Markdown image rendering are proposed separately. They are not part of this layout diff.
