# Copilot Resurrect

> **Keep your autonomous GitHub Copilot Chat loops alive — overnight, unattended, indefinitely.**

[![Version](https://img.shields.io/badge/version-1.0.0-blue.svg)](https://github.com/putersdcat/copilot-resurrect)
[![VS Code](https://img.shields.io/badge/VS%20Code-%5E1.85.0-007ACC.svg)](https://code.visualstudio.com/)

---

## The Problem

GitHub Copilot Chat is uniquely powerful for running autonomous coding agents using Frontier models. A well-crafted **ignition prompt** can instruct Copilot to:

- Pull open backlog items from GitHub Issues
- Implement, test, and commit them
- Update issue status
- Loop indefinitely

These workflows routinely run **5–18+ hours** unattended — when they stay alive. But Copilot Chat sessions terminate unpredictably due to:

- Server-side throttling or malformed-prompt aborts
- Token-limit / context-window overflows on session rollover
- Transient network / data-centre failovers (TCP reset)
- Model-router errors that bypass the built-in retry mechanism

When termination happens, the chat panel simply **stops**. No restart. No alert. Hours of autonomous work lost.

**Copilot Resurrect solves this.** It watches for silence, detects a dead session, and automatically re-injects your ignition prompt to start a fresh session — all while you sleep.

---

## Features

| Feature | Detail |
|---|---|
| 🔍 **Silence Detection** | Monitors Copilot Chat session storage via `FileSystemWatcher`; falls back to a polling heartbeat |
| 🔄 **Auto Resurrection** | Focuses Copilot Chat, pastes your ignition prompt, and submits — no human required |
| ⏱️ **Configurable Timeout** | 60–600 second silence window before declaring a session dead (default: 180 s) |
| 🛡️ **Daily Rate Cap** | Configurable max restarts per calendar day (default: 50) to prevent infinite storms |
| 💾 **Persistent Counter** | Restart count persists across VS Code restarts via `globalState` |
| 📋 **Clipboard-Safe** | Saves and restores your clipboard before/after prompt injection |
| 📝 **Model Hint Prefix** | Optional model hint (e.g. `@gpt-4o`) prepended to the ignition prompt |
| 📊 **Output Log** | Full timestamped log in the **Copilot Resurrection Watcher** Output Channel |
| 🟢 **Status Bar Item** | Live status indicator in the bottom-right of the VS Code window |
| 🧪 **Dry Run Test** | Test the full resurrection sequence without actually submitting anything |

---

## Quick Start

### 1. Install

Install the `.vsix` directly:

```
code --install-extension copilot-resurrect-1.0.0.vsix
```

Or install from the Extensions Marketplace (when published).

### 2. Configure Your Ignition Prompt

Open the Command Palette (`Ctrl+Shift+P`) and run:

```
Copilot Resurrect: Configure Ignition Prompt
```

Enter the prompt you want Copilot to receive every time a session is resurrected. Example:

```
You are an autonomous coding agent. Pull the next open issue from the GitHub backlog, implement the required changes, write tests, commit with a descriptive message, push, close the issue, then loop to the next one. Continue until all issues are resolved.
```

### 3. Enable the Watcher

```
Copilot Resurrect: Enable Watcher
```

The status bar will show `$(debug-restart) Resurrect ON`. You're live.

### 4. Walk Away

Open your Copilot Chat panel, queue your ignition prompt manually, and let it run. Copilot Resurrect will keep it alive in the background.

---

## Configuration Reference

All settings are available under **Settings → Extensions → Copilot Resurrect** or in `settings.json`:

| Setting | Type | Default | Description |
|---|---|---|---|
| `copilot-resurrect.enabled` | `boolean` | `false` | Enable/disable the watcher |
| `copilot-resurrect.ignitionPrompt` | `string` | `""` | The prompt injected on resurrection |
| `copilot-resurrect.silenceTimeoutSeconds` | `number` | `180` | Seconds of silence before resurrection triggers (60–600) |
| `copilot-resurrect.maxRestartsPerDay` | `number` | `50` | Maximum auto-restarts per calendar day (1–200) |
| `copilot-resurrect.modelHint` | `string` | `""` | Optional prefix prepended to the prompt (e.g. `@gpt-4o`) |
| `copilot-resurrect.watchPaths` | `string[]` | `[]` | Override auto-discovered watch paths (advanced / rarely needed) |

### Example `settings.json` entry

```jsonc
"copilot-resurrect.enabled": true,
"copilot-resurrect.ignitionPrompt": "Pull the next open GitHub Issue, implement it, test it, commit it, close the issue, then loop.",
"copilot-resurrect.silenceTimeoutSeconds": 240,
"copilot-resurrect.maxRestartsPerDay": 40,
"copilot-resurrect.modelHint": ""
```

---

## Commands

All commands are available via the Command Palette (`Ctrl+Shift+P`):

| Command | Description |
|---|---|
| `Copilot Resurrect: Enable Watcher` | Start monitoring for silence |
| `Copilot Resurrect: Disable Watcher` | Stop monitoring |
| `Copilot Resurrect: Toggle Watcher` | Toggle enabled/disabled |
| `Copilot Resurrect: Show Status` | Print current state to log + info toast |
| `Copilot Resurrect: Test Resurrection (dry run)` | Walk through the resurrection sequence without submitting |
| `Copilot Resurrect: Configure Ignition Prompt` | Set/update the ignition prompt via input box |
| `Copilot Resurrect: Reset Daily Restart Counter` | Reset today's restart count back to zero |
| `Copilot Resurrect: Show Output Log` | Open the **Copilot Resurrection Watcher** Output Channel |

---

## How It Works

### Detection

```
SessionWatcher
  │
  ├─ FileSystemWatcher → github.copilot-chat/chatSessions/*.json
  │     onDidChange / onDidCreate / onDidDelete → bump last-activity timestamp
  │
  └─ 15-second polling heartbeat
        if (now - lastActivity) >= silenceTimeoutSeconds → trigger resurrection
```

Path discovery is automatic and prioritised in this order:
1. `workspaceStorage/<hash>/github.copilot-chat/chatSessions/`
2. `workspaceStorage/<hash>/github.copilot-chat/`
3. `globalStorage/github.copilot-chat/`
4. Hard-coded platform fallbacks (`%APPDATA%\Code\User\globalStorage\...`)

Custom paths can be set via `copilot-resurrect.watchPaths` to bypass discovery entirely.

### Resurrection Sequence

```
1. Save current clipboard contents
2. Execute: workbench.action.chat.focus
3. Write ignition prompt (+ modelHint prefix) to clipboard
4. Execute: editor.action.clipboardPasteAction  ← injects into chat input
5. Execute: workbench.action.chat.submit         ← fires the prompt
6. Restore clipboard
7. Increment daily counter  (persisted via globalState)
8. Reset silence timer
```

### Rate Limiting

- Restarts are capped at `maxRestartsPerDay` per calendar day.
- The counter auto-resets at midnight (UTC).
- When the cap is reached, a warning toast appears with a **Reset Counter** action.
- An in-flight resurrection blocks concurrent triggers.

---

## Status Bar

The bottom-right status bar shows live state:

| Display | Meaning |
|---|---|
| `$(debug-restart) Resurrect ON (3/50)` | Watcher active; 3 restarts used today out of 50 cap |
| `$(debug-pause) Resurrect OFF` | Watcher disabled |
| `$(loading~spin) Resurrecting…` | Resurrection sequence in progress |

Click the status bar item to toggle the watcher on/off.

---

## Troubleshooting

### The watcher starts but never resurrects

- Verify your `ignitionPrompt` is set (non-empty). Open **Configure Ignition Prompt**.
- Run **Show Status** and check `Seconds since last activity`. If it never reaches the timeout, the FileSystemWatcher is detecting activity — which is correct behaviour (session is still alive).
- If Copilot Chat writes session files to an unusual path, set `copilot-resurrect.watchPaths` manually and point it at the correct folder.

### My prompt is not appearing in the chat input

- The clipboard-paste injection requires the Copilot Chat input box to be focused. Ensure no modal dialogs are blocking the VS Code window.
- Try increasing `silenceTimeoutSeconds` slightly — if the paste fires while Copilot is mid-response the focus may not land on the input.

### Daily counter looks wrong

- Run **Reset Daily Restart Counter** to zero it out.
- The counter is per-machine, stored in `globalState`. It resets automatically at midnight UTC.

### Verbose debugging

Open **Copilot Resurrect: Show Output Log** and look for `[DEBUG]` lines. The log includes every file-system event, every heartbeat tick, and every step of the resurrection sequence.

---

## Architecture

```
copilot-resurrect/
├── src/
│   ├── extension.ts          ← Activate/deactivate, command registration, config change listener
│   ├── config.ts             ← Settings schema types, getConfig(), buildFullPrompt()
│   ├── sessionWatcher.ts     ← FileSystemWatcher + polling heartbeat
│   ├── resurrectionEngine.ts ← Resurrection sequence + rate-limiting + daily counter
│   ├── pathDiscovery.ts      ← Dynamic Copilot Chat storage path discovery
│   ├── logger.ts             ← Timestamped Output Channel wrapper
│   └── statusBar.ts          ← Status bar item lifecycle
├── out/                      ← Compiled JavaScript (generated)
├── package.json              ← Extension manifest, settings schema, command contributions
└── tsconfig.json             ← TypeScript config
```

---

## Building from Source

```powershell
cd copilot-resurrect
npm install
npm run compile          # tsc -p ./
npx vsce package         # produces copilot-resurrect-x.x.x.vsix
```

**Install locally:**

```powershell
code --install-extension copilot-resurrect-1.0.0.vsix --force
```

---

## Limitations & Roadmap

### Current Limitations (MVP)

- Does **not** detect VS Code crashes that take down the entire IDE process.
- Single-workspace only (does not bridge remote SSH/WSL sessions).
- No content-awareness — cannot distinguish "thinking for 5 minutes" from "dead". Tune `silenceTimeoutSeconds` to account for your model's typical latency.

### Phase 2 Ideas

- **Light content check** — inspect last N bytes of the most recently modified session file to detect error markers without full JSON parsing.
- **Notification integration** — push a desktop notification / Teams/Slack webhook when a resurrection fires.
- **Multi-workspace support** — per-workspace watcher instances.
- **Session analytics** — export daily restart log as CSV.

---

## License

MIT — see [LICENSE](LICENSE).

---

## Author

Eric Anderson — built with GitHub Copilot Chat (March 2026).

> *"The extension that keeps the lights on."*
