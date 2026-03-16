import * as vscode from 'vscode';
import { Logger } from './logger';
import { ResurrectConfig } from './config';
import { discoverWatchDirs } from './pathDiscovery';
import * as p from 'path';

export type SilenceCallback = () => void;

/**
 * SessionWatcher monitors Copilot Chat session files for activity.
 * When no file-system activity is detected for longer than
 * config.silenceTimeoutSeconds, it fires the onSilenceDetected callback.
 */
export class SessionWatcher implements vscode.Disposable {
  private _fsWatchers: vscode.FileSystemWatcher[] = [];
  private _silenceTimer: ReturnType<typeof setTimeout> | undefined;
  private _lastActivityAt: Date = new Date();
  private _pollInterval: ReturnType<typeof setInterval> | undefined;
  private _onSilenceDetected: SilenceCallback;
  private _config: ResurrectConfig;
  private _context: vscode.ExtensionContext;
  private _active = false;

  constructor(
    context: vscode.ExtensionContext,
    config: ResurrectConfig,
    onSilenceDetected: SilenceCallback
  ) {
    this._context = context;
    this._config = config;
    this._onSilenceDetected = onSilenceDetected;
  }

  get active(): boolean {
    return this._active;
  }

  get lastActivityAt(): Date {
    return this._lastActivityAt;
  }

  get secondsSinceActivity(): number {
    return Math.floor((Date.now() - this._lastActivityAt.getTime()) / 1000);
  }

  start(config?: ResurrectConfig): void {
    if (config) {
      this._config = config;
    }
    this.stop();   // clean up any previous watchers
    this._active = true;
    this._lastActivityAt = new Date();

    Logger.separator();
    Logger.info('SessionWatcher starting…');

    // ── File-system watches ───────────────────────────────────────────────
    const overridePaths = this._config.watchPaths;
    const watchDirs: string[] =
      overridePaths.length > 0 ? overridePaths : discoverWatchDirs(this._context);

    let watchersCreated = 0;
    for (const dir of watchDirs) {
      try {
        // vscode.workspace.createFileSystemWatcher accepts
        // either a workspace RelativePattern or an absolute glob string.
        const glob = new vscode.RelativePattern(
          vscode.Uri.file(dir),
          '**/*.json'
        );
        const watcher = vscode.workspace.createFileSystemWatcher(
          glob,
          false,  // ignoreCreateEvents
          false,  // ignoreChangeEvents
          false   // ignoreDeleteEvents
        );

        const touchActivity = (uri: vscode.Uri) => {
          Logger.debug(`File activity: ${uri.fsPath}`);
          this._bumpActivity();
        };

        watcher.onDidChange(touchActivity);
        watcher.onDidCreate(touchActivity);
        watcher.onDidDelete(touchActivity);

        this._fsWatchers.push(watcher);
        watchersCreated++;
      } catch (err) {
        Logger.warn(`Could not create watcher for ${dir}: ${err}`);
      }
    }

    if (watchersCreated === 0) {
      Logger.warn('No file-system watchers created. Using timer-only silence detection.');
    } else {
      Logger.info(`${watchersCreated} file-system watcher(s) active.`);
    }

    // ── Polling heartbeat – checks silence threshold every 15s ────────────
    this._pollInterval = setInterval(() => {
      const elapsed = this.secondsSinceActivity;
      const timeout = this._config.silenceTimeoutSeconds;

      Logger.debug(`Heartbeat: ${elapsed}s since last activity (timeout: ${timeout}s)`);

      if (elapsed >= timeout) {
        Logger.warn(`Silence threshold reached (${elapsed}s ≥ ${timeout}s). Triggering resurrection…`);
        this._bumpActivity(); // reset timer to avoid re-triggering during resurrection
        this._onSilenceDetected();
      }
    }, 15_000);

    Logger.info(
      `SessionWatcher active. Silence timeout: ${this._config.silenceTimeoutSeconds}s. ` +
      `Max restarts/day: ${this._config.maxRestartsPerDay}.`
    );
  }

  stop(): void {
    for (const w of this._fsWatchers) {
      w.dispose();
    }
    this._fsWatchers = [];

    if (this._silenceTimer) {
      clearTimeout(this._silenceTimer);
      this._silenceTimer = undefined;
    }
    if (this._pollInterval) {
      clearInterval(this._pollInterval);
      this._pollInterval = undefined;
    }

    this._active = false;
    Logger.info('SessionWatcher stopped.');
  }

  /** Call this to manually register activity (e.g., after a resurrection). */
  bumpActivity(): void {
    this._bumpActivity();
  }

  private _bumpActivity(): void {
    this._lastActivityAt = new Date();
  }

  dispose(): void {
    this.stop();
  }
}
