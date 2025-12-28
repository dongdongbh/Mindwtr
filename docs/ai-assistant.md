# AI Assistant (BYOK)

Mindwtr includes an optional AI assistant to help clarify tasks, break them down, and review stale items. It is **off by default** and uses a **bring-your-own-key (BYOK)** model.

## Privacy Model

- **Local-first**: Your data stays on your device.
- **On-demand**: Requests are only sent when you tap AI actions or enable Copilot suggestions.
- **Scoped**: The assistant only receives the task data it needs (title/description/limited context).

## Supported Providers

- **OpenAI**
- **Google Gemini**

Configure in **Settings → AI assistant**:

- Enable/disable AI
- Provider
- Model
- API key (stored locally only)
- Reasoning effort / thinking budget (provider-dependent)

## Features

### Clarify
Ask the assistant to turn a vague task into a concrete next action with suggested contexts/tags.

### Breakdown
Generate a short checklist of next steps for large tasks. You choose what to apply.

### Review Analysis
During weekly review, the assistant can flag stale tasks and suggest actions like:
- Move to Someday/Maybe
- Archive
- Break down
- Keep

### Copilot Suggestions
As you type, Mindwtr can suggest:
- Contexts
- Tags
- Time estimates

Copilot uses a fast model by default and never applies changes without your approval.

## Notes

- AI is **optional** — Mindwtr works fully without it.
- Responses are parsed as structured JSON; if parsing fails, no changes are applied.

