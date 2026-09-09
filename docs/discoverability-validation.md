# Discoverability validation

Keep everyday Focus, Inbox, Projects and Review screens free of persistent help panels
and help buttons. First-run guidance may be dismissed; detailed help belongs in the
existing task/project editors or the help/docs entry point. Settings search is a tool
inside Settings, not another prompt on the task list.

## Automated checks

After a production desktop web build, run `bun run test:settings-browser`. It uses fresh
synthetic browser storage and blocks external requests. At 800px and 1280px in light and
dark themes it checks visible Settings search, keyboard selection/Escape, exact-row
navigation/highlighting and no document overflow. Screenshots are retained under
`build/settings-discoverability`; weekly/manual CI runs the same check. Component tests
cover result paths, disclosure expansion, keyboard navigation and clearing stale queries.
These checks establish function and layout, not whether a first-time user can find a feature.

## First-time-user session (20 minutes)

Recruit five people unfamiliar with Mindwtr, mixing mobile and desktop use. Include keyboard
and assistive-technology users where possible. Use synthetic data, with consent before
recording; do not collect their personal tasks, accounts or credentials. Record the exact
build, platform, viewport/text scaling, input method, and whether onboarding was dismissed.

Ask participants to think aloud. Present goals without naming controls or giving a tour:

1. “Remember to send the revised proposal tomorrow.” Capture it, then find it again.
2. “These three steps belong to the same outcome.” Organize them and choose what to do next.
3. “You cannot do this until Friday.” Set it aside, then show where you would find it again.
4. “The text is difficult to read.” Find and change the relevant preference.
5. “You want a copy of your data before switching devices.” Find the safe export/backup route;
   do not connect a real account or overwrite a personal database.

Alternate task order between participants to reduce learning effects. Allow up to two minutes
without hints, then record the obstacle and offer help. Stop immediately if a task would risk
personal data. After completing the session, ask what each ambiguous label meant to them and
where they expected the missing action to be. Observe a second short session after they have
used the app: onboarding must not intrude into ordinary work.

Record one row per attempt:

| Participant alias | Task | Completed unaided? | Time | Wrong turns / label confusion | Hint required | Severity |
|---|---|---|---|---|---|---|
| | | | | | | |

Prioritize blocked capture, lost confidence in saved data, destructive ambiguity and repeated
failures. Prefer clearer labels, better grouping and search terms over additional tutorial UI.
Treat five-person results as qualitative evidence, not population conversion statistics.
Attach anonymized observations and a repeatable acceptance task to each proposed fix. There
are no participant findings in this document yet; automated tests are not usability research.
