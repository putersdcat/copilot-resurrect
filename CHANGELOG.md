# Changelog

## [1.0.0] - 2026-03-09

### Added
- Initial MVP release of **Copilot Resurrect**.
- `SessionWatcher`: Monitors Copilot Chat session files for silence using `vscode.FileSystemWatcher` + heartbeat polling.
- `ResurrectionEngine`: Clipboard-paste-based prompt injection + `workbench.action.chat.submit`.
- Daily restart counter persisted via `ExtensionContext.globalState` with automatic midnight reset.
- Status bar item showing watcher state and daily restart count.
- Full set of commands: Enable, Disable, Toggle, Test Resurrection (dry-run), Show Status, Reset Counter, Show Log, Configure Prompt.
- Settings schema: `enabled`, `ignitionPrompt`, `silenceTimeoutSeconds`, `maxRestartsPerDay`, `modelHint`, `watchPaths`.
- Dynamic path discovery for Copilot Chat session files (workspaceStorage + globalStorage + OS fallbacks).
- Dedicated Output Channel "Copilot Resurrection Watcher" for all telemetry.

[1.0.0]: https://github.com/putersdcat/copilot-resurrect/releases/tag/v1.0.0
