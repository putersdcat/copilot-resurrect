import * as vscode from 'vscode';
import { Logger } from './logger';
import { ResurrectConfig, buildFullPrompt, compactIgnitionPrompt, getEffectiveFallbackModelChain, normalizeErrorCode } from './config';
import { DetectedError, resetScanCache } from './errorDetector';
import { buildPersistedRateLimitState, clearRateLimitState, isModelCoolingDown, loadRateLimitState, saveRateLimitState } from './rateLimitState';

/** Key used to save daily restart records in globalState. */
const DAILY_STATE_KEY = 'copilot-resurrect.dailyRestarts';
/** Key for tracking consecutive rate-limit failures for exponential backoff. */
const CONSECUTIVE_RL_KEY = 'copilot-resurrect.consecutiveRateLimits';

interface DailyState {
  date: string; // YYYY-MM-DD
  count: number;
}

interface RecoveryPlan {
  fullPrompt: string;
  startNewSession: boolean;
  usedPromptCompaction: boolean;
  promptCompactionReason: string | null;
  suggestedFallbackModel: string | null;
  requiresManualModelSwitch: boolean;
}

export type ResurrectionTrigger = 'silence' | 'rate_limit' | 'server_error' | 'content_filtered' | 'unknown_error' | 'manual';

/**
 * ResurrectionEngine handles:
 *  - Rate-limiting via the daily restart counter (persisted in globalState).
 *  - Exponential backoff cooldown when rate-limit errors are detected.
 *  - The actual resurrection sequence using VS Code chat commands (no clipboard).
 */
export class ResurrectionEngine {
  private _context: vscode.ExtensionContext;
  private _isResurrecting = false;
  private _cooldownTimer: ReturnType<typeof setTimeout> | undefined;
  private _onCooldownTick: ((secondsRemaining: number) => void) | undefined;
  private _consecutiveRateLimits = 0;

  constructor(context: vscode.ExtensionContext) {
    this._context = context;
    this._consecutiveRateLimits = context.globalState.get<number>(CONSECUTIVE_RL_KEY, 0);
  }

  get isResurrecting(): boolean {
    return this._isResurrecting;
  }

  get isCoolingDown(): boolean {
    return this._cooldownTimer !== undefined;
  }

  /** How many automatic resurrections have been triggered today. */
  get todayCount(): number {
    const state = this._getDailyState();
    return state.count;
  }

  /** Register a callback for cooldown tick updates (for status bar). */
  set onCooldownTick(cb: ((secondsRemaining: number) => void) | undefined) {
    this._onCooldownTick = cb;
  }

  /** Reset the daily counter (exposed as a command). */
  resetDailyCounter(): void {
    const fresh: DailyState = { date: todayString(), count: 0 };
    this._context.globalState.update(DAILY_STATE_KEY, fresh);
    Logger.info('Daily restart counter reset to 0.');
  }

  /** Reset the exponential backoff counter (e.g., after successful session). */
  resetBackoff(): void {
    this._consecutiveRateLimits = 0;
    this._context.globalState.update(CONSECUTIVE_RL_KEY, 0);
    Logger.info('Exponential backoff counter reset.');
  }

  /**
   * Calculate the current cooldown duration using exponential backoff.
   * Formula: min(base * 2^consecutive, max)
   */
  calculateCooldown(config: ResurrectConfig): number {
    const base = config.rateLimitCooldownBaseSeconds;
    const max = config.rateLimitCooldownMaxSeconds;
    const cooldown = Math.min(base * Math.pow(2, this._consecutiveRateLimits), max);
    return Math.round(cooldown);
  }

  /**
   * Attempt to resurrect the Copilot Chat session.
   * Returns true on success, false if blocked (rate-limit, no prompt, etc.)
   *
   * For error-based triggers (rate_limit, server_error, content_filtered):
   *   Uses `workbench.action.chat.retry` to hit the "Try Again" button
   *   in the existing session, preserving in-progress work context.
   *
   * For silence/manual triggers:
   *   Injects the ignition prompt into a new or existing session.
   *
   * @param config Current extension configuration.
   * @param dryRun If true, logs all steps but does NOT execute commands.
   * @param trigger What caused the resurrection (silence, rate_limit, etc.)
   */
  async resurrect(
    config: ResurrectConfig,
    dryRun = false,
    trigger: ResurrectionTrigger = 'manual',
    detectedError?: DetectedError,
  ): Promise<boolean> {
    const recoveryPlan = this._buildRecoveryPlan(config, trigger, detectedError);

    if (this._isResurrecting) {
      Logger.warn('Resurrection already in progress. Skipping duplicate trigger.');
      return false;
    }

    if (this._cooldownTimer) {
      Logger.warn('Cooldown in progress. Skipping resurrection trigger.');
      return false;
    }

    // Error-based triggers use retry-in-place — no ignition prompt needed.
    // Silence/manual triggers require a prompt to restart the loop.
    const isErrorTrigger = trigger === 'rate_limit' || trigger === 'server_error' || trigger === 'content_filtered' || trigger === 'unknown_error';

    if (!isErrorTrigger) {
      const fullPrompt = recoveryPlan.fullPrompt;
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

    // ── Exponential backoff cooldown for rate-limit triggers ───────────────
    if (trigger === 'rate_limit' && !dryRun) {
      this._consecutiveRateLimits++;
      this._context.globalState.update(CONSECUTIVE_RL_KEY, this._consecutiveRateLimits);

      const explicitCooldown = detectedError?.details?.cooldownSeconds ?? 0;
      const cooldownSeconds = Math.max(this.calculateCooldown(config), explicitCooldown);
      const previousRateLimitState = loadRateLimitState(this._context);
      const persistedState = buildPersistedRateLimitState(
        errorOrFallback(trigger, detectedError),
        config,
        this._consecutiveRateLimits,
        recoveryPlan.suggestedFallbackModel,
        previousRateLimitState,
      );

      if (persistedState) {
        await saveRateLimitState(this._context, persistedState);
      }

      Logger.info(
        `Error trigger [${trigger}] (consecutive: ${this._consecutiveRateLimits}). ` +
        `Exponential backoff: waiting ${cooldownSeconds}s before retry…`
      );
      if (recoveryPlan.suggestedFallbackModel) {
        Logger.info(
          `Suggested fallback model: ${recoveryPlan.suggestedFallbackModel} ` +
          `${recoveryPlan.requiresManualModelSwitch ? '(manual switch required in chat UI for this mode)' : ''}`
        );
      }
      if (detectedError?.details) {
        Logger.info(
          `Rate-limit details: code=${detectedError.details.code || '(none)'} ` +
          `severity=${detectedError.details.severity} ` +
          `scope=${detectedError.details.scope} ` +
          `retryAfter=${detectedError.details.retryAfterSeconds ?? '(none)'} ` +
          `resource=${detectedError.details.headers.resource || '(none)'} ` +
          `requestId=${detectedError.details.headers.requestId || '(none)'}`
        );
        if (detectedError.details.message) {
          Logger.info(`Rate-limit message: ${detectedError.details.message}`);
        }
      }
      vscode.window.showInformationMessage(
        `Copilot Resurrect: ${trigger}. Backoff cooldown: ${cooldownSeconds}s ` +
        `(attempt ${this._consecutiveRateLimits})`
      );
      await this._cooldown(cooldownSeconds);
      Logger.info('Cooldown complete. Proceeding with resurrection.');
    }

    this._isResurrecting = true;
    Logger.separator();
    Logger.info(
      `Resurrection attempt #${state.count + 1} (today). ` +
      `Trigger: ${trigger}. Strategy: ${isErrorTrigger ? 'RETRY in-place' : (config.startNewSession ? 'IGNITION prompt (new session)' : 'IGNITION prompt (existing session)')}. ` +
      `DryRun: ${dryRun}. ` +
      `Model: ${config.preferredModel || '(default)'}. ` +
      `SuggestedFallback: ${recoveryPlan.suggestedFallbackModel || '(none)'}. ` +
      `Participant: ${config.chatParticipant || '(none)'}. ` +
      `AgentMode: ${config.agentMode || '(default)'}. ` +
      `Approvals: ${config.approvalsMode}. ` +
      `NewSession: ${recoveryPlan.startNewSession}`
    );
    if (detectedError?.details) {
      Logger.info(
        `Structured error context: code=${detectedError.details.code || '(none)'} ` +
        `cooldown=${detectedError.details.cooldownSeconds}s ` +
        `severity=${detectedError.details.severity}`
      );
    }
    if (recoveryPlan.usedPromptCompaction) {
      Logger.info(`Prompt compaction enabled for this recovery (${recoveryPlan.promptCompactionReason}).`);
    }

    try {
      // ═══════════════════════════════════════════════════════════════════════
      // PATH A: Error-based triggers → retry in the existing session
      // ═══════════════════════════════════════════════════════════════════════
      if (isErrorTrigger) {
        return await this._retryInPlace(config, recoveryPlan, dryRun, trigger, state);
      }

      // ═══════════════════════════════════════════════════════════════════════
      // PATH B: Silence / manual → inject ignition prompt
      // ═══════════════════════════════════════════════════════════════════════
      return await this._ignitionPromptResurrect(config, recoveryPlan, dryRun, trigger, state);
    } catch (err) {
      Logger.error('Resurrection failed', err);
      vscode.window.showErrorMessage(`Copilot Resurrect: Resurrection failed — ${err}`);
      return false;
    } finally {
      this._isResurrecting = false;
    }
  }

  /**
   * Retry the last request in the existing chat session ("Try Again" button).
   *
   * NOTE: `workbench.action.chat.retry` does NOT exist in VS Code 1.112.0.
   * The "Try Again" button in Copilot Chat is handled internally via webview
   * postMessage and is not accessible via a registered VS Code command.
   *
   * Therefore, error-based triggers fall through to _ignitionPromptResurrect —
   * the ignition prompt re-starts the conversation cleanly, which is equivalent
   * to what "Try Again" would do (the session context is already dead/halted
   * when the error state is shown). The user's configured model, agent mode,
   * and approvals settings are still applied from config.
   */
  private async _retryInPlace(
    config: ResurrectConfig,
    plan: RecoveryPlan,
    dryRun: boolean,
    trigger: ResurrectionTrigger,
    state: DailyState,
  ): Promise<boolean> {
    if (dryRun) {
      Logger.info(`[DRY RUN] Error trigger [${trigger}] — would use ignition prompt (workbench.action.chat.retry unavailable)`);
      await sleep(200);
      Logger.info('[DRY RUN] Would execute: workbench.action.chat.open + ignition prompt injection');
      Logger.info('[DRY RUN] Retry simulation complete.');
      return true;
    }

    Logger.info('workbench.action.chat.retry is not available in VS Code 1.112.0. Using ignition prompt resurrection instead.');
    return await this._ignitionPromptResurrect(config, plan, false, trigger, state);
  }

  /**
   * Classic resurrection: inject the ignition prompt into a new or existing session.
   * Used for silence-based detection and as a fallback when retry-in-place fails.
   */
  private async _ignitionPromptResurrect(
    config: ResurrectConfig,
    plan: RecoveryPlan,
    dryRun: boolean,
    trigger: ResurrectionTrigger,
    state: DailyState,
  ): Promise<boolean> {
    const fullPrompt = plan.fullPrompt;
    if (!fullPrompt) {
      Logger.warn('ignitionPrompt is empty. Cannot resurrect via ignition prompt.');
      return false;
    }

    Logger.info(`Prompt: ${fullPrompt.substring(0, 120)}${fullPrompt.length > 120 ? '…' : ''}`);
    if (plan.suggestedFallbackModel) {
      Logger.info(`Recovery will proceed with suggested fallback model: ${plan.suggestedFallbackModel}`);
      if (plan.requiresManualModelSwitch) {
        Logger.info('Current VS Code/Copilot surfaces do not expose unattended model switching for this mode. Manual switch may still be required.');
      }
    }

    if (dryRun) {
      Logger.info(`[DRY RUN] Would execute: workbench.action.chat.newChat (effective startNewSession=${plan.startNewSession})`);
      await sleep(200);
      if (config.agentMode) {
        Logger.info(`[DRY RUN] Would switch agent mode to: ${config.agentMode}`);
        await sleep(200);
      }
      Logger.info(`[DRY RUN] Would execute: workbench.action.chat.open with query (${fullPrompt.length} chars)`);
      await sleep(200);
      Logger.info('[DRY RUN] Would execute: workbench.action.chat.submit');
      Logger.info('[DRY RUN] Resurrection simulation complete.');
      return true;
    }

    // ── Step 1: Optionally start new chat session  ──────────────────────
    if (plan.startNewSession) {
      Logger.info('Starting new chat session…');
      await vscode.commands.executeCommand('workbench.action.chat.newChat');
      await sleep(600);

      // Switch to configured agent mode
      if (config.agentMode) {
        Logger.info(`Switching to agent mode: ${config.agentMode}…`);
        try {
          await vscode.commands.executeCommand(
            'workbench.action.chat.switchChatMode',
            config.agentMode
          );
          await sleep(400);
        } catch (err) {
          Logger.warn(`Could not switch chat mode to "${config.agentMode}": ${err}`);
        }
      }

      // Approvals mode reminder for new sessions
      if (config.approvalsMode !== 'default') {
        const modeLabel = config.approvalsMode === 'bypass'
          ? 'Bypass Approvals'
          : 'Autopilot (Preview)';
        Logger.info(`Approvals mode preference: ${modeLabel}. User may need to confirm in the chat UI.`);
        vscode.window.showInformationMessage(
          `Copilot Resurrect: New session started. Set approvals to "${modeLabel}" in the chat dropdown if needed.`,
          'Dismiss'
        );
      }
    } else {
      // ── Focus existing chat (chat.open with no query just focuses) ────
      Logger.info('Focusing existing Copilot Chat panel…');
      await vscode.commands.executeCommand('workbench.action.chat.open', {});
      await sleep(400);
    }

    // ── Step 2: Inject prompt via chat open command (no clipboard)  ──────
    Logger.info('Injecting prompt via workbench.action.chat.open…');
    await vscode.commands.executeCommand('workbench.action.chat.open', {
      query: fullPrompt,
      isPartialQuery: true,
    });
    await sleep(400);

    // ── Step 3: Submit  ─────────────────────────────────────────────────
    Logger.info('Submitting prompt…');
    await vscode.commands.executeCommand('workbench.action.chat.submit');
    await sleep(300);

    // ── Reset error detection cache so new session gets a fresh baseline ─
    resetScanCache();

    // ── Reset backoff on successful non-error triggers  ───────────────
    if (!this._isErrorTrigger(trigger)) {
      this.resetBackoff();
      await clearRateLimitState(this._context);
    }

    // ── Increment counter  ───────────────────────────────────────────────
    this._incrementDailyState();
    Logger.info(`Resurrection complete. Today's count: ${this.todayCount}/${config.maxRestartsPerDay}.`);

    vscode.window.showInformationMessage(
      `Copilot Resurrect: Session restarted [${trigger}] (${this.todayCount}/${config.maxRestartsPerDay} today).`
    );

    return true;
  }

  private _buildRecoveryPlan(
    config: ResurrectConfig,
    trigger: ResurrectionTrigger,
    detectedError?: DetectedError,
  ): RecoveryPlan {
    const isRateLimit = trigger === 'rate_limit';
    const details = detectedError?.details;
    const severeRateLimit = details?.severity === 'high' || details?.severity === 'critical';

    let startNewSession = config.startNewSession;
    if (isRateLimit && config.preferNewSessionOnRateLimit) {
      startNewSession = true;
    }
    if (isRateLimit && severeRateLimit) {
      startNewSession = true;
    }

    let promptText = config.ignitionPrompt;
    let usedPromptCompaction = false;
    let promptCompactionReason: string | null = null;

    if (isRateLimit && config.promptCompactionEnabled && promptText.trim()) {
      const compacted = compactIgnitionPrompt(promptText, config.promptCompactionStrategy);
      if (compacted && compacted !== promptText.trim()) {
        promptText = compacted;
        usedPromptCompaction = true;
        promptCompactionReason = config.promptCompactionStrategy;
      }
    }

    const suggestedFallbackModel = this._selectSuggestedFallbackModel(config, details?.code ?? null);

    return {
      fullPrompt: buildFullPrompt(config, promptText),
      startNewSession,
      usedPromptCompaction,
      promptCompactionReason,
      suggestedFallbackModel,
      requiresManualModelSwitch: !!suggestedFallbackModel,
    };
  }

  private _selectSuggestedFallbackModel(
    config: ResurrectConfig,
    errorCode: string | null,
  ): string | null {
    const normalizedCode = normalizeErrorCode(errorCode);
    if (!normalizedCode) {
      return null;
    }

    const shouldSuggestModel =
      normalizedCode.startsWith('model_') ||
      normalizedCode === 'quota_exceeded' ||
      normalizedCode === 'too_many_requests' ||
      normalizedCode === 'user_global_rate_limited' ||
      normalizedCode === 'user_rate_limited' ||
      normalizedCode === 'rate_limited';

    if (!shouldSuggestModel) {
      return null;
    }

    const chain = getEffectiveFallbackModelChain(config);
    if (chain.length === 0) {
      return null;
    }

    const persistedState = loadRateLimitState(this._context);

    const currentPreferred = config.preferredModel.trim().toLowerCase();
    const currentIndex = currentPreferred
      ? chain.findIndex(model => model.toLowerCase() === currentPreferred)
      : -1;

    for (let i = currentIndex + 1; i < chain.length; i++) {
      const candidate = chain[i];
      if (!isModelCoolingDown(persistedState, candidate)) {
        return candidate;
      }
    }

    if (chain[0] && chain[0].toLowerCase() !== currentPreferred && !isModelCoolingDown(persistedState, chain[0])) {
      return chain[0];
    }

    for (const candidate of chain) {
      if (!isModelCoolingDown(persistedState, candidate)) {
        return candidate;
      }
    }

    return chain[currentIndex + 1] ?? chain[0] ?? null;
  }

  private _isErrorTrigger(trigger: ResurrectionTrigger): boolean {
    return trigger === 'rate_limit' || trigger === 'server_error' || trigger === 'content_filtered' || trigger === 'unknown_error';
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /** Exposed for _retryInPlace / _ignitionPromptResurrect which receive state as a param. */
  private _getDailyState(): DailyState {
    const stored = this._context.globalState.get<DailyState>(DAILY_STATE_KEY);
    const today = todayString();
    if (!stored || stored.date !== today) {
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

  /** Wait for the specified cooldown period, ticking every second. */
  private _cooldown(seconds: number): Promise<void> {
    return new Promise(resolve => {
      let remaining = seconds;
      this._cooldownTimer = setInterval(() => {
        remaining--;
        this._onCooldownTick?.(remaining);
        if (remaining <= 0) {
          if (this._cooldownTimer) {
            clearInterval(this._cooldownTimer);
            this._cooldownTimer = undefined;
          }
          resolve();
        }
      }, 1000);
    });
  }
}

function errorOrFallback(trigger: ResurrectionTrigger, detectedError?: DetectedError): DetectedError {
  if (detectedError) {
    return detectedError;
  }

  return {
    type: trigger === 'rate_limit' ? 'rate_limit' : 'unknown_error',
    pattern: trigger,
    filePath: '',
    timestamp: new Date(),
  };
}

function todayString(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
