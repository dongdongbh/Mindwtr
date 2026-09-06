# Mindwtr Unreleased

Changes collected after `v1.2.8` and before the next version tag.

## Full Change List

- Android: labels no longer lose their last character after the system font size changes while Mindwtr is still running. Dates such as "26-09-05", counts such as "(2)", tag chips and the filter sheet's Save button were drawn at the new size inside boxes measured at the old one, so the trailing glyph was cut or wrapped out of sight until the app was force-closed. Mindwtr now tells React Native to re-measure text when the font scale changes. (#1161)

