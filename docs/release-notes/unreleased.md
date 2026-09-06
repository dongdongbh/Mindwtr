# Mindwtr Unreleased

Changes collected after `v1.2.8` and before the next version tag.

## Full Change List

- Desktop: quick-mode inbox processing now lets you list more than one next action when turning an item into a project, with the same "Add another action" rows the guided mode already had. Each extra row becomes its own task in the new project. (#1167)
- Desktop: Timeline project rows now show the area color for a project that was never recolored, matching the task bars under it. Every project stores a placeholder grey until you pick a color, and the Timeline group dot and bar read that grey as a chosen color, so projects looked grey while their tasks were purple.
- Desktop: the project header's "..." menu (Details, Duplicate, Archive, Delete) no longer renders underneath the sticky task toolbar on engines that treat the header's container-query box as its own layer. The header is now lifted above the toolbar only while that menu or the project-type help bubble is open.
- Desktop: Tab now indents a list item in project notes and Shift+Tab outdents it, the same way it already worked in a task's description. The notes preview also shows nested items at their depth instead of flattening every bullet and checkbox to one level, and an item indented four spaces or a tab no longer turns into plain text.
- Android: labels no longer lose their last character after the system font size changes while Mindwtr is still running. Dates such as "26-09-05", counts such as "(2)", tag chips and the filter sheet's Save button were drawn at the new size inside boxes measured at the old one, so the trailing glyph was cut or wrapped out of sight until the app was force-closed. Mindwtr now tells React Native to re-measure text when the font scale changes. (#1161)

