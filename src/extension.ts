/**
 * Copilot Resurrect – main extension entry point.
 *
 * Activate on onStartupFinished.
 * Registers all commands, wires up SessionWatcher + ResurrectionEngine,
 * and responds to configuration changes.
 */
import * as vscode from 'vscode';
import { Logger } from './logger';
import { getConfig, setEnabled, EXT_ID } from './config';
import { SessionWatcher } from './sessionWatcher';
import { ResurrectionEngine } from './resurrectionEngine';
import { ResurrectStatusBar } from './statusBar';

let _watcher: SessionWatcher | undefined;
let _engine: ResurrectionEngine | undefined;
let _statusBar: ResurrectStatusBar | undefined;

// ── Activate ──────────────────────────────────────────────────────────────────
export function activate(context: vscode.ExtensionContext): void {
  Logger.init();
  Logger.separator();
  Logger.info('Copilot Resurrect extension activating…');

  _engine = new ResurrectionEngine(context);
  _statusBar = new ResurrectStatusBar();
  _watcher = new SessionWatcher(context, getConfig(), handleSilence);

  // Push all disposables
  context.subscriptions.push(
    Logger.channel,
    _statusBar,
    _watcher
  );

  // ── Register commands ──────────────────────────────────────────────────────
  context.subscriptions.push(

    vscode.commands.registerCommand('copilot-resurrect.enable', async () => {
      await setEnabled(true);
      startWatcher();
      vscode.window.showInformationMessage('Copilot Resurrect: Watcher ENABLED.');
      Logger.info('Watcher enabled via command.');
    }),

    vscode.commands.registerCommand('copilot-resurrect.disable', async () => {
      await setEnabled(false);
      stopWatcher();
      vscode.window.showInformationMessage('Copilot Resurrect: Watcher DISABLED.');
      Logger.info('Watcher disabled via command.');
    }),

    vscode.commands.registerCommand('copilot-resurrect.toggle', async () => {
      const cfg = getConfig();
      if (cfg.enabled) {
        await vscode.commands.executeCommand('copilot-resurrect.disable');
      } else {
        await vscode.commands.executeCommand('copilot-resurrect.enable');
      }
    }),

    vscode.commands.registerCommand('copilot-resurrect.testResurrection', async () => {
      Logger.show();
      Logger.info('=== TEST RESURRECTION (dry run) ===');
      const cfg = getConfig();
      const ok = await _engine!.resurrect(cfg, /* dryRun */ true);
      if (ok) {
        vscode.window.showInformationMessage(
          'Copilot Resurrect: Dry-run completed. Check the Output panel for details.'
        );
      }
    }),

    vscode.commands.registerCommand('copilot-resurrect.status', () => {
      const cfg = getConfig();
      const count = _engine?.todayCount ?? 0;
      const watching = _watcher?.active ?? false;
      const elapsed = _watcher?.secondsSinceActivity ?? 0;

      const message = [
        `Copilot Resurrect Status:`,
        `  Enabled: ${cfg.enabled}`,
        `  Watcher active: ${watching}`,
        `  Silence timeout: ${cfg.silenceTimeoutSeconds}s`,
        `  Seconds since last activity: ${elapsed}s`,
        `  Restarts today: ${count} / ${cfg.maxRestartsPerDay}`,
        `  Model hint: ${cfg.modelHint || '(none)'}`,
        `  Prompt configured: ${!!cfg.ignitionPrompt}`,
      ].join('\n');

      Logger.show();
      Logger.info(message);
      vscode.window.showInformationMessage(
        `Resurrect: ${watching ? 'ACTIVE' : 'INACTIVE'} | ` +
        `Restarts today: ${count}/${cfg.maxRestartsPerDay} | ` +
        `Silence: ${elapsed}s/${cfg.silenceTimeoutSeconds}s`
      );
    }),

    vscode.commands.registerCommand('copilot-resurrect.resetDailyCounter', () => {
      _engine?.resetDailyCounter();
      updateStatusBar();
      vscode.window.showInformationMessage('Copilot Resurrect: Daily restart counter reset.');
    }),

    vscode.commands.registerCommand('copilot-resurrect.showLog', () => {
      Logger.show();
    }),

    vscode.commands.registerCommand('copilot-resurrect.configurePrompt', async () => {
      const cfg = getConfig();
      const input = await vscode.window.showInputBox({
        prompt: 'Enter your Copilot Chat ignition prompt',
        placeHolder: 'e.g. Pull open backlog items, implement and commit them, then loop.',
        value: cfg.ignitionPrompt,
        ignoreFocusOut: true,
      });
      if (input !== undefined) {
        await vscode.workspace
          .getConfiguration(EXT_ID)
          .update('ignitionPrompt', input, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage('Copilot Resurrect: Ignition prompt saved.');
        Logger.info(`Ignition prompt updated (${input.length} chars).`);
      }
    }),
  );

  // ── React to configuration changes ────────────────────────────────────────
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration(EXT_ID)) {
        Logger.info('Configuration changed. Re-evaluating watcher state…');
        const cfg = getConfig();
        updateStatusBar();
        if (cfg.enabled && !_watcher?.active) {
          startWatcher();
        } else if (!cfg.enabled && _watcher?.active) {
          stopWatcher();
        } else if (cfg.enabled && _watcher?.active) {
          // Restart watcher with updated config (e.g. new timeout)
          startWatcher();
        }
      }
    })
  );

  // ── Auto-start if enabled ─────────────────────────────────────────────────
  const cfg = getConfig();
  if (cfg.enabled) {
    startWatcher();
  } else {
    _statusBar.setEnabled(false);
    Logger.info('Watcher is disabled. Enable it via the command palette or Settings.');
  }

  Logger.info('Copilot Resurrect extension activated.');
}

// ── Deactivate ────────────────────────────────────────────────────────────────
export function deactivate(): void {
  stopWatcher();
  Logger.info('Copilot Resurrect extension deactivated.');
}

// ── Internal helpers ─────────────────────────────────────────────────────────

function startWatcher(): void {
  const cfg = getConfig();
  _watcher?.start(cfg);
  updateStatusBar();
}

function stopWatcher(): void {
  _watcher?.stop();
  updateStatusBar();
}

function updateStatusBar(): void {
  const cfg = getConfig();
  const count = _engine?.todayCount ?? 0;
  _statusBar?.setEnabled(cfg.enabled, count, cfg.maxRestartsPerDay);
}

async function handleSilence(): Promise<void> {
  const cfg = getConfig();

  Logger.warn('Silence detected — initiating resurrection sequence.');
  _statusBar?.setResurrecting();

  const success = await _engine!.resurrect(cfg, false);

  if (success) {
    _watcher?.bumpActivity();
  }

  updateStatusBar();
}
