**VS Code Extension Development Spec**  
**Project Name:** Copilot Session Resurrection Watcher (working title)  
**Version:** 1.0 (MVP)  
**Author:** Eric Anderson (via Grok collaboration)  
**Date:** March 2026  

### 1. Problem Statement (Macro-Level)

GitHub Copilot Chat in VS Code is currently the most powerful way to run long-running, autonomous coding agents (especially with Frontier models via GitHub Enterprise). Developers can queue an “ignition prompt” that tells the model to:

- Pull open backlog items from GitHub Issues  
- Implement, test, and commit them  
- Update issue status  
- Loop indefinitely  

This workflow routinely runs 5–18+ hours straight when everything is healthy.  

However, **Copilot Chat sessions terminate unpredictably** for reasons completely outside the user’s control:

- Server-side throttling or malformed-prompt aborts  
- Token-limit / context-window overflows (especially on session rollover)  
- Transient network / data-center failovers (TCP reset)  
- Model-router errors that do not trigger the built-in retry/queue mechanism  

When any of these happen the queued next prompt is **never executed**. The chat panel simply stops. There is no official “watchdog” or auto-respawn capability.

Existing extensions (e.g. Copilot Auto-Retry) handle only rate-limit / transient cases and deliberately avoid reading session state or injecting custom prompts. No published extension solves the full “keep this autonomous loop alive overnight even after fatal termination” problem.

### 2. Desired Outcomes / Success Criteria

After installing and enabling the extension, a developer should be able to:

1. Walk away from the keyboard (or go to sleep) with one ignition prompt queued.  
2. Return 8–18 hours later to find either:  
   - Every backlog item processed and issues updated, **or**  
   - The session has been cleanly resurrected multiple times and is still running the same ignition prompt.  
3. Zero manual intervention required once the watcher is active.  
4. The extension must survive VS Code restarts, workspace reloads, and future Copilot Chat UI changes with minimal or zero code changes.

Success is measured by:  
- 95%+ of fatal terminations result in automatic restart within < 60 seconds.  
- No data loss or duplicate work introduced by the resurrection logic.  
- Extension remains maintainable by a single developer (you).

### 3. Scope & Key Requirements (MVP)

#### In Scope
- Detect when a Copilot Chat session has terminated (dead silence).  
- Automatically start a **brand-new** Copilot Chat session using a user-configured ignition prompt and model.  
- Provide simple, persistent configuration stored in VS Code settings.  
- Graceful degradation: if resurrection fails, log clearly and stop (do not spam).  
- Work with any Frontier model selectable via Copilot Chat (no hard-coded models).

#### Out of Scope (for MVP – can be Phase 2)
- Reading or parsing the actual prompt/response content (keep it zero-knowledge where possible).  
- Smart decision-making based on backlog state or issue triage.  
- Handling VS Code or Copilot crashes that take down the entire IDE.  
- Multi-workspace or remote (SSH/WSL) support.  
- GUI panel / status bar widget beyond a simple enable/disable toggle.

### 4. High-Level Architecture

The design is deliberately **brutally simple** (“dumb watcher + heartbeat”) so it remains reliable even as Copilot’s internal implementation evolves.

1. **Configuration Layer**  
   - User stores in `settings.json` (editable via VS Code Settings UI):  
     - `copilot-resurrect.enabled` (boolean)  
     - `copilot-resurrect.ignitionPrompt` (multi-line string)  
     - `copilot-resurrect.silenceTimeoutSeconds` (default 180, range 60–600)  
     - `copilot-resurrect.maxRestartsPerDay` (default 50)  
     - `copilot-resurrect.modelHint` (optional string, e.g. “@gpt-4o” – prefixed to prompt if supplied)

2. **Detection Layer**  
   - Dynamically locate the exact folder Copilot Chat uses for session storage (`workspaceStorage/<random-hash>/chatSessions/*.json`).  
   - Use `vscode.workspace.createFileSystemWatcher` with a workspace-relative glob pattern to watch **only** modification time and file size (no content parsing in MVP).  
   - A background timer checks the last write timestamp; if no activity for longer than the configured silence timeout, the session is declared dead.

3. **Resurrection Layer**  
   - Execute `workbench.action.chat.focus` to bring the Copilot Chat panel to front.  
   - Inject the stored ignition prompt (plus optional model hint) into the chat input box using the standard clipboard-paste + focus pattern.  
   - Immediately execute the native `workbench.action.chat.submit` command (the same one the UI uses for Enter/Send).  
   - Reset the silence timer and increment the daily restart counter.

4. **Safety & Telemetry Layer**  
   - Dedicated Output Channel (“Copilot Resurrection Watcher”) for all logs.  
   - Rate-limiting and daily restart cap enforced in memory (persisted via `vscode.ExtensionContext.globalState`).  
   - Extension activates on `onStartupFinished` and restores watch state automatically.

### 5. Key Technical Considerations (Only Confirmed Reliable Paths)

- **Dynamic log-path discovery**  
  The workspace storage hash is the same value VS Code and Copilot Chat already read internally. Extensions can locate it reliably at runtime using `vscode.workspace.workspaceFolders` combined with the standard `globalStorage` / `workspaceStorage` path resolution pattern (used by every major Copilot-adjacent extension in 2026).

- **File-system watching**  
  `vscode.workspace.createFileSystemWatcher("** /chatSessions/*.json", false, false, false)` + `onDidChange` event is the documented, stable, and future-proof method. Only watch modification time + size change – zero JSON parsing required for MVP.

- **Chat interaction commands**  
  `workbench.action.chat.focus` and `workbench.action.chat.submit` are stable public commands (unchanged since 2024 and still used by multiple marketplace extensions in 2026). The clipboard-paste injection method for the input box is the only reliable cross-version technique without relying on internal APIs.

- **Configuration & persistence**  
  `vscode.workspace.getConfiguration("copilot-resurrect")` + `update()` for settings + `ExtensionContext.globalState` for the daily restart counter. All fully typed and version-safe.

- **Lifecycle**  
  `activate()` registers the watcher and timer only when `enabled` is true; `deactivate()` cleanly disposes the watcher. State survives VS Code restarts automatically.

These are the **only** technical details included because they are proven by existing published extensions and official VS Code API stability as of March 2026. No undocumented internals or DOM hacks are required.

### 6. Risks & Mitigations

- Copilot changes its log file format or location → Mitigation: dynamic discovery + clear warning in Output panel + one-line config override.  
- Submit command behaviour changes with new Copilot UI → Mitigation: ship with clear release notes; user can disable watcher instantly via settings.  
- False-positive “dead” detections during very long model thinking → Mitigation: configurable timeout (start at 180 s, user tunes); optional future Phase-2 light content check.

### 7. Next Steps for You (the Developer)

1. Create a new TypeScript extension skeleton (`yo code`).  
2. Implement the settings schema first (so you can test config round-tripping).  
3. Add the file-system watcher and basic silence detection (log only).  
4. Wire up the focus + submit sequence with a manual “Test Resurrection” command.  
5. Iterate on timeout tuning with real overnight runs.

This augmented spec keeps the focus on **planning and desired outcomes** while giving you just enough confirmed technical anchors to start implementation immediately. You retain full freedom to research exact paths and edge cases in real time.
