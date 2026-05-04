# Pomodoro Focus

Mindwtr includes an optional Pomodoro timer panel in the **Focus** view on desktop and mobile.

By default, this feature is **off** to keep Focus minimal and distraction-free.

---

## Enable Pomodoro

### Desktop
1. Open **Settings**.
2. Go to **GTD**.
3. Turn on **Pomodoro timer** under **Features**.
4. Open **Focus** view.

### Mobile
1. Open **Menu → Settings**.
2. Go to **GTD**.
3. Turn on **Pomodoro timer** under **Features**.
4. Open the **Focus** tab.

---

## How It Works

- Optionally pick one **Timer task** from your current Focus candidates, or leave it as **Timer only**.
- Choose a preset: `15/3`, `25/5`, `50/10`, or one optional custom preset from **Settings → GTD**
- Start your focus session.
- When a focus session ends, Mindwtr switches to break and pauses so you can start intentionally.
- When a break ends, it switches back to focus.

Task linking is off by default. Turn on **Settings → GTD → Pomodoro timer → Link timer to task** when you want the Timer task picker and **Mark task done** action in Focus.

Controls:
- **Timer**: Start/Pause, Reset, and Switch phase
- **Task update**: Mark task done, which completes the selected Timer task

The task picker controls which task, if any, the Pomodoro panel is attached to. Timer controls affect the timer. **Mark task done** is only available when a Timer task is linked, and mutates that selected task by moving it to Done and removing it from today's focus.

---

## Focus vs Next Actions

The **Focus** view is not a 1:1 copy of the full Next Actions list. It is an Engage dashboard:

- **Today's Focus**: up to 3 tasks you explicitly marked for today
- **Today**: next tasks due today, overdue, or starting today
- **Next Actions**: currently available next tasks
- **Review Due**: waiting/tickler items that need attention

Focus intentionally hides tasks with future start dates and later tasks in sequential projects. That keeps the view limited to work you can act on now. Use **Contexts**, **Projects**, or **Search** when you want to inspect broader task inventory, including future-start tasks.

---

## When To Use It

- Use it when you want a lightweight timer without leaving the current GTD Focus workflow.
- Keep it off if you prefer Focus to stay strictly list-based with no timer UI.
- Treat it as an aid for doing the next action, not as a separate planning system.

## Practical Patterns

- Use `15/3` for inbox cleanup, small admin work, or getting unstuck.
- Use `25/5` as the default daily rhythm for normal next actions.
- Use `50/10` for deep project work when the task is already clear enough to start.
- Use a custom preset if you need one different rhythm, but keep it simple.
- Use **Mark task done** only when the linked Timer task is actually finished; otherwise pause or switch phase and keep the task alive.

---

## Notes

- Pomodoro can run as a plain timer, or you can link it to a Timer task when you want task-level completion from the panel.
- The panel is intentionally opt-in so users who prefer a clean GTD Focus page can keep it hidden.
- The built-in presets stay fixed and simple. Mindwtr only adds one optional custom preset so Focus does not turn into a timer customization screen.
