# AI Assistant (BYOK)

Mindwtr includes an optional AI assistant to help clarify tasks, break them down, and review stale items. It is **off by default** and uses a **bring-your-own-key (BYOK)** model.

## Privacy Model

- **Local-first**: Your data stays on your device.
- **On-demand**: Requests are only sent when you tap AI actions or enable Copilot suggestions.
- **Scoped**: The assistant only receives the task data it needs.

## Supported Providers

- **OpenAI**
- **Google Gemini**
- **Anthropic (Claude)**

Configure in **Settings → AI assistant**:

- Enable/disable AI
- Provider
- Model
- Optional custom OpenAI-compatible base URL
- API key (stored locally only)
- Reasoning effort / thinking budget (provider-dependent)
- Optional **“Enable thinking”** toggle for Claude/Gemini (adds extended reasoning)

## OpenAI-Compatible Endpoints (Local or Hosted)

Mindwtr can talk to any service that exposes an **OpenAI-compatible Chat Completions API**. This includes local servers and some hosted providers.

Use this setup for:

- **Official OpenAI**: leave **Custom base URL** blank and use your OpenAI API key.
- **Local servers**: Ollama, LM Studio, LocalAI, vLLM, and similar.
- **Hosted OpenAI-compatible providers**: for example GLM or other vendors that expose an OpenAI-compatible endpoint.

1. If needed, start or obtain access to an OpenAI-compatible endpoint.
2. In **Settings → AI assistant**:
   - Set **Provider** to **OpenAI**
   - Set **Model** to the model name exposed by that service
   - Set **Custom base URL** to the service's base URL
   - Enter an **API key** if that service requires bearer auth
3. Leave **Custom base URL** blank only for official OpenAI.
4. Leave **API key** blank only if your custom endpoint allows unauthenticated requests.

Mindwtr appends `/chat/completions` automatically, so use the provider base URL rather than the full chat-completions path unless your service requires the full path.

Common base URLs:
- **Ollama**: `http://localhost:11434/v1`
- **LM Studio**: `http://localhost:1234/v1`
- **LocalAI / vLLM**: `http://localhost:8080/v1`

Example for GLM-style hosted endpoints:

- **Provider**: `OpenAI`
- **Model**: the GLM model id exposed by your provider, such as `GLM-4.7`
- **Custom base URL**: your provider's OpenAI-compatible base URL
- **API key**: your provider key if required

## Features

### Clarify
Turn a vague task into a concrete next action with suggested contexts/tags.

### Breakdown
Generate a short checklist of next steps for large tasks. You choose what to apply.

### Review Analysis
During weekly review, the assistant can flag stale tasks and suggest actions like:
- Move to Someday/Maybe
- Archive
- Break down
- Keep

### Copilot Suggestions
(Only available in Inbox and Focus views)

As you type, Mindwtr can suggest:
- Contexts
- Tags
- Time estimates

Copilot never applies changes without your approval.

### Speech to Text

Transcribe voice notes into tasks.

- **Offline (Whisper)**: Download a model (~75MB for Tiny, ~150MB for Base) to transcribe fully offline.
- **Cloud (OpenAI/Gemini)**: Use your API key for high-accuracy transcription.
- **Modes**:
  - **Smart Parse**: Extracts due dates, projects, and priorities from natural speech (e.g., "Buy milk tomorrow priority high").
  - **Transcript Only**: Just the text.

## Notes

- AI is **optional** — Mindwtr works fully without it.
- Responses are parsed as structured JSON; if parsing fails, no changes are applied.
## Whisper language codes

If you use the Whisper offline model, you can set an explicit language code in Settings → AI Assistant → Audio language.
See the language list here: [Whisper language list](https://whisper-api.com/docs/languages/).
