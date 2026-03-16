import * as vscode from 'vscode';
import { Logger } from './logger';
import { ResurrectConfig, buildFullPrompt } from './config';

/** Key used to save daily restart records in globalState. */
const DAILY_STATE_KEY = 'copilot-resurrect.dailyRestarts';

interface DailyState {
  date: string; // YYYY-MM-DD
  count: number;
}

/**
 * ResurrectionEngine handles:
 *  - Rate-limiting via the daily restart counter (persisted in globalState).
 *  - The actual resurrection sequence: focus → inject prompt → submit.
 */
export class ResurrectionEngine {
  private _context: vscode.ExtensionContext;
  private _isResurrecting = false;

  constructor(context: vscode.ExtensionContext) {
    this._context = context;
  }

  /** How many automatic resurrections have been triggered today. */
  get todayCount(): number {
    const state = this._getDailyState();
    return state.count;
  }

  /** Reset the daily counter (exposed as a command). */
  resetDailyCounter(): void {
    const fresh: DailyState = { date: todayString(), count: 0 };
    this._context.globalState.update(DAILY_STATE_KEY, fresh);
    Logger.info('Daily restart counter reset to 0.');
  }

  /**
   * Attempt to resurrect the Copilot Chat session.
   * Returns true on success, false if blocked (rate-limit, no prompt, etc.)
   * @param dryRun If true, logs all steps but does NOT execute clipboard/submit commands.
   */
  async resurrect(config: ResurrectConfig, dryRun = false): Promise<boolean> {
    if (this._isResurrecting) {
      Logger.warn('Resurrection already in progress. Skipping duplicate trigger.');
      return false;
    }

    const fullPrompt = buildFullPrompt(config);
    if (!fullPrompt) {
      Logger.warn('ignitionPrompt is empty. Cannot resurrect. Please configure copilot-resurrect.ignitionPrompt.');
      vscode.window.showWarningMessage(
        'Copilot Resurrect: ignitionPrompt is not set. Open Settings to configure it.',
        'Open Settings'
      ).then((sel: string | undefined) => {
        if (sel === 'Open Settings') {
          vscode.commands.executeCommand('workbench.action.openSettings', 'copilot-resurrect.ignitionPrompt');
        }
      });
      return false;
    }

    // ── Daily rate-limit check ─────────────────────────────────────────────
    const state = this._getDailyState();
    if (state.count >= config.maxRestartsPerDay) {
      Logger.warn(
        `Daily restart cap reached (${state.count}/${config.maxRestartsPerDay}). ` +
        `Halting resurrection. Run "Copilot Resurrect: Reset Daily Counter" to resume.`
      );
      vscode.window.showWarningMessage(
        `Copilot Resurrect has hit its daily cap of ${config.maxRestartsPerDay} restarts. ` +
        `Use the "Reset Daily Counter" command to resume.`,
        'Reset Counter'
      ).then((sel: string | undefined) => {
        if (sel === 'Reset Counter') {
          this.resetDailyCounter();
        }
      });
      return false;
    }

    this._isResurrecting = true;
    Logger.separator();
    Logger.info(`Resurrection attempt #${state.count + 1} (today). DryRun: ${dryRun}`);
    Logger.info(`Prompt: ${fullPrompt.substring(0, 120)}${fullPrompt.length > 120 ? '…' : ''}`);

    try {
      if (dryRun) {
        Logger.info('[DRY RUN] Would execute: workbench.action.chat.focus');
        await sleep(300);
        Logger.info('[DRY RUN] Would write prompt to clipboard');
        await sleep(300);
        Logger.info('[DRY RUN] Would execute: editor.action.clipboardPasteAction');
        await sleep(300);
        Logger.info('[DRY RUN] Would execute: workbench.action.chat.submit');
        Logger.info('[DRY RUN] Resurrection simulation complete.');
        return true;
      }

      // ── Step 1: Save clipboard  ──────────────────────────────────────────
      const previousClipboard = await vscode.env.clipboard.readText();
      Logger.debug('Clipboard saved.');

      // ── Step 2: Focus Copilot Chat  ──────────────────────────────────────
      Logger.info('Focusing Copilot Chat panel…');
      await vscode.commands.executeCommand('workbench.action.chat.focus');
      await sleep(500);

      // ── Step 3: Write prompt to clipboard  ──────────────────────────────
      await vscode.env.clipboard.writeText(fullPrompt);
      Logger.debug('Prompt written to clipboard.');
      await sleep(200);

      // ── Step 4: Paste into the chat input  ──────────────────────────────
      Logger.info('Pasting prompt into chat input…');
      await vscode.commands.executeCommand('editor.action.clipboardPasteAction');
      await sleep(400);

      // ── Step 5: Submit  ─────────────────────────────────────────────────
      Logger.info('Submitting prompt…');
      await vscode.commands.executeCommand('workbench.action.chat.submit');
      await sleep(300);

      // ── Step 6: Restore clipboard  ──────────────────────────────────────
      await vscode.env.clipboard.writeText(previousClipboard);
      Logger.debug('Clipboard restored.');

      // ── Increment counter  ───────────────────────────────────────────────
      this._incrementDailyState();
      Logger.info(`Resurrection complete. Today's count: ${this.todayCount}/${config.maxRestartsPerDay}.`);

      vscode.window.showInformationMessage(
        `Copilot Resurrect: Session restarted (${this.todayCount}/${config.maxRestartsPerDay} today).`
      );

      return true;
    } catch (err) {
      Logger.error('Resurrection failed', err);
      vscode.window.showErrorMessage(`Copilot Resurrect: Resurrection failed — ${err}`);
      return false;
    } finally {
      this._isResurrecting = false;
    }
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private _getDailyState(): DailyState {
    const stored = this._context.globalState.get<DailyState>(DAILY_STATE_KEY);
    const today = todayString();
    if (!stored || stored.date !== today) {
      // New day – auto-reset
      const fresh: DailyState = { date: today, count: 0 };
      this._context.globalState.update(DAILY_STATE_KEY, fresh);
      return fresh;
    }
    return stored;
  }

  private _incrementDailyState(): void {
    const state = this._getDailyState();
    const updated: DailyState = { date: state.date, count: state.count + 1 };
    this._context.globalState.update(DAILY_STATE_KEY, updated);
  }
}

function todayString(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
