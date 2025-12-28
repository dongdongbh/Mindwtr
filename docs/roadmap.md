# Mindwtr Roadmap

This document captures the phased product roadmap and how work splits between `@mindwtr/core` and the desktop/mobile apps.

---

## ✅ Phase 1 — GTD Completeness (Complete)

- ✅ Recurring Tasks Engine
- ✅ Tickler / Review Dates
- ✅ Project Lifecycle + Next Action Discipline

---

## ✅ Phase 2 — Daily Capture & Engagement (Complete)

- ✅ Shared Quick‑Add Parser (Natural Language)
- ✅ Frictionless Capture Entry Points (global hotkey, tray, share sheet)
- ✅ Notifications / Reminders with Snooze

---

## ✅ Phase 2.5 — Search & Quick Actions (Complete)

- ✅ Advanced Search + Saved Searches
- ✅ Subtask Progress Indicators
- ✅ Collapsible Sidebar (Desktop)

---

## ✅ Phase 3 — Trust, Sync, and Organization (Complete)

- ✅ Auto‑Sync + Status
- ✅ Bulk Actions & List Customization
- ✅ Task Dependencies / Blocking
- ✅ Hierarchical Contexts/Tags
- ✅ Areas (Project Groups)

---

## ✅ Phase 4 — Power‑User & Reference (Complete)

- ✅ Markdown Notes + Attachments
- ✅ Desktop Keyboard/A11y Pass
- ✅ Daily Digest Notifications
- ✅ Additional Sync Backends (WebDAV)
- ✅ Reusable Lists (Templates + checklist reset)
- ✅ AI Assistant (BYOK clarify/breakdown/review + copilot)

---

## ✅ Phase 5 — Expansion (In Progress)

### ✅ Web App (PWA)
**Goal:** Browser-based access for any device.

- ✅ Desktop UI runs in normal browser using localStorage
- ✅ PWA support with manifest and service worker
- Run: `bun desktop:web` | Build: `bun desktop:web:build`

### ✅ Cloud Sync
**Goal:** Optional cloud-based sync service.

- ✅ Simple REST API server (`apps/cloud/src/server.ts`)
- ✅ GET/PUT `/v1/data` with Bearer token auth
- ✅ Desktop + Mobile sync to cloud backend
- Run: `bun run --filter mindwtr-cloud dev -- --port 8787`

### ✅ Integrations & Automation
**Goal:** Enable power users to automate capture and review.

- ✅ **CLI** (`scripts/mindwtr-cli.ts`): add, list, complete, search
- ✅ **Local REST API** (`scripts/mindwtr-api.ts`): Full CRUD for tasks/projects
- Run CLI: `bun mindwtr:cli -- add "Task title @context"`
- Run API: `bun mindwtr:api -- --port 4317`

### 🔜 Android Widget
**Goal:** Surface agenda on home screen.

- ✅ Focus/Next widget with quick capture (2x2)

---

## 🔜 Phase 6 — Calendar Integration (Hard + Soft Landscape)

**Goal:** Show external calendar events as read-only “Hard Landscape” and let users schedule existing tasks (“Soft Landscape”) into free time.

- **Core**
  - Clarify semantics: `dueDate` = deadline; `startTime` = tickler/scheduled start; `timeEstimate` = duration hint.
  - Helpers for day planning (group by day, compute blocks, conflict detection).
- **Desktop**
  - Day + 3‑day timeline views with drag scheduling.
  - External calendar overlays (ICS) with refresh/status.
- **Mobile**
  - Day + month views with task scheduling.
  - Settings UI for ICS subscriptions and refresh.
