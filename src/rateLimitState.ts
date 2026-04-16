import * as vscode from 'vscode';
import type { ResurrectConfig } from './config';
import type { DetectedError, RateLimitInfo } from './errorDetector';

export const RATE_LIMIT_STATE_KEY = 'copilot-resurrect.rateLimitState';

export interface PersistedModelCooldownState {
  model: string;
  lastErrorCode: string | null;
  cooldownUntil: string | null;
  consecutiveFailures: number;
  lastDetectedAt: string;
}

export interface PersistedRateLimitState {
  lastDetectedAt: string;
  lastPattern: string;
  lastErrorCode: string | null;
  lastMessage: string | null;
  severity: RateLimitInfo['severity'];
  scope: RateLimitInfo['scope'];
  cooldownUntil: string | null;
  cooldownSeconds: number;
  retryAfterSeconds: number | null;
  resource: string | null;
  requestId: string | null;
  preferredModel: string | null;
  fallbackModel: string | null;
  fallbackModelChain: string[];
  suggestedFallbackModel: string | null;
  modelCooldowns: Record<string, PersistedModelCooldownState>;
  consecutiveFailures: number;
}

function normalizeModelKey(model: string): string {
  return model.trim().toLowerCase();
}

export function buildPersistedRateLimitState(
  error: DetectedError,
  config: Pick<ResurrectConfig, 'preferredModel' | 'fallbackModel' | 'fallbackModelChain'>,
  consecutiveFailures: number,
  suggestedFallbackModel: string | null = null,
  previousState?: PersistedRateLimitState,
): PersistedRateLimitState | null {
  const details = error.details;
  if (!details) {
    return null;
  }

  const nowIso = error.timestamp.toISOString();
  const cooldownUntil = details.cooldownSeconds > 0
    ? new Date(Date.now() + details.cooldownSeconds * 1000).toISOString()
    : null;
  const modelCooldowns: Record<string, PersistedModelCooldownState> = {
    ...(previousState?.modelCooldowns ?? {}),
  };

  const preferredModel = config.preferredModel.trim();
  if (preferredModel) {
    const key = normalizeModelKey(preferredModel);
    const previousModelState = modelCooldowns[key];
    modelCooldowns[key] = {
      model: preferredModel,
      lastErrorCode: details.code,
      cooldownUntil,
      consecutiveFailures: (previousModelState?.consecutiveFailures ?? 0) + 1,
      lastDetectedAt: nowIso,
    };
  }

  return {
    lastDetectedAt: nowIso,
    lastPattern: error.pattern,
    lastErrorCode: details.code,
    lastMessage: details.message,
    severity: details.severity,
    scope: details.scope,
    cooldownUntil,
    cooldownSeconds: details.cooldownSeconds,
    retryAfterSeconds: details.retryAfterSeconds,
    resource: details.headers.resource,
    requestId: details.headers.requestId,
    preferredModel: config.preferredModel || null,
    fallbackModel: config.fallbackModel || null,
    fallbackModelChain: [...config.fallbackModelChain],
    suggestedFallbackModel,
    modelCooldowns,
    consecutiveFailures,
  };
}

export async function saveRateLimitState(
  context: vscode.ExtensionContext,
  state: PersistedRateLimitState,
): Promise<void> {
  await context.globalState.update(RATE_LIMIT_STATE_KEY, state);
}

export function loadRateLimitState(
  context: vscode.ExtensionContext,
): PersistedRateLimitState | undefined {
  return context.globalState.get<PersistedRateLimitState>(RATE_LIMIT_STATE_KEY);
}

export async function clearRateLimitState(context: vscode.ExtensionContext): Promise<void> {
  await context.globalState.update(RATE_LIMIT_STATE_KEY, undefined);
}

export function formatRateLimitStateSummary(state?: PersistedRateLimitState): string {
  if (!state) {
    return '(none)';
  }

  const code = state.lastErrorCode || state.lastPattern;
  const cooldown = state.cooldownUntil
    ? `${Math.max(0, Math.ceil((new Date(state.cooldownUntil).getTime() - Date.now()) / 1000))}s remaining`
    : 'no cooldown';
  const suggestion = state.suggestedFallbackModel
    ? ` | next=${state.suggestedFallbackModel}`
    : '';

  return `${code} | severity=${state.severity} | scope=${state.scope} | ${cooldown}${suggestion}`;
}

export function getModelCooldownState(
  state: PersistedRateLimitState | undefined,
  model: string,
): PersistedModelCooldownState | undefined {
  if (!state || !model.trim()) {
    return undefined;
  }

  return state.modelCooldowns[normalizeModelKey(model)];
}

export function isModelCoolingDown(
  state: PersistedRateLimitState | undefined,
  model: string,
): boolean {
  const modelState = getModelCooldownState(state, model);
  if (!modelState?.cooldownUntil) {
    return false;
  }

  return new Date(modelState.cooldownUntil).getTime() > Date.now();
}