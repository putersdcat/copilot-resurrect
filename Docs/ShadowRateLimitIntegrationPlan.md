# Shadow Rate Limit Integration Plan

**Date:** April 16, 2026  
**Status:** In progress  
**Related Docs:** `RateLimitIntegrationResearch.md`, `ShadowRateLimits.md`

---

## Executive Summary

GitHub Copilot has undocumented "Shadow Rate Limits" — custom 429 responses that are **separate from** the standard GitHub API rate limit system. These are service-level protections that can hit even when `GET /rate_limit` shows plenty of remaining API calls. This plan addresses integrating detection, obfuscation, model fallback strategies, and intelligent retry logic.

---

## 1. Shadow Rate Limit Error Codes

Based on research, the following error codes may appear in Copilot 429 responses:

### Error Code Taxonomy

| Code | Type | Severity | Likely Duration |
|------|------|----------|----------------|
| `user_global_rate_limited` | Service/Global | High | Minutes to hours |
| `user_global_rate_limited:pro` | Service/Global (tiered) | High | Minutes to hours |
| `user_weekly_rate_limited` | Weekly Quota | Critical | ~1 week |
| `user_hourly_rate_limited` | Hourly Quota | Medium | ~1 hour |
| `user_daily_rate_limited` | Daily Quota | Medium | ~24 hours |
| `user_rate_limited` | Generic User | Medium | Variable |
| `model_rate_limited` | Model-Specific | High | Minutes to hours |
| `model_capacity_limited` | Model Capacity | High | Minutes to hours |
| `quota_exceeded` | Generic Quota | Medium | Variable |
| `too_many_requests` | Generic 429 | Low | Seconds to minutes |

### Response Structure

```json
{
  "error": {
    "message": "Sorry, you've exceeded your weekly rate limit...",
    "code": "user_weekly_rate_limited"
  }
}
```

---

## 2. Enhanced Error Detection (`errorDetector.ts`)

### 2.1 New Error Patterns

```typescript
// NEW: Shadow rate limit patterns
const SHADOW_RATE_LIMIT_PATTERNS: Array<{ regex: RegExp; type: ErrorType; label: string; severity: 'critical' | 'high' | 'medium' | 'low' }> = [
  // Weekly limits — CRITICAL
  {
    regex: /user_weekly_rate_limited/i,
    type: 'rate_limit',
    label: 'weekly rate limit exceeded',
    severity: 'critical',
  },
  // Hourly/Daily limits
  {
    regex: /user_hourly_rate_limited/i,
    type: 'rate_limit',
    label: 'hourly rate limit exceeded',
    severity: 'medium',
  },
  {
    regex: /user_daily_rate_limited/i,
    type: 'rate_limit',
    label: 'daily rate limit exceeded',
    severity: 'medium',
  },
  // Global limits
  {
    regex: /user_global_rate_limited:pro/i,
    type: 'rate_limit',
    label: 'global rate limit (pro tier)',
    severity: 'high',
  },
  {
    regex: /user_global_rate_limited/i,
    type: 'rate_limit',
    label: 'global rate limit exceeded',
    severity: 'high',
  },
  // Model-specific limits
  {
    regex: /model_capacity_limited/i,
    type: 'rate_limit',
    label: 'model capacity exceeded',
    severity: 'high',
  },
  {
    regex: /model_rate_limited/i,
    type: 'rate_limit',
    label: 'model rate limit exceeded',
    severity: 'high',
  },
  // Generic patterns
  {
    regex: /quota_exceeded/i,
    type: 'rate_limit',
    label: 'quota exceeded',
    severity: 'medium',
  },
  {
    regex: /user_rate_limited/i,
    type: 'rate_limit',
    label: 'user rate limited',
    severity: 'medium',
  },
];
```

### 2.2 Extract Error Code from Response

```typescript
interface RateLimitErrorInfo {
  code: string | null;        // e.g., "user_weekly_rate_limited"
  message: string;
  retryAfter: number | null;  // seconds from Retry-After header
  rateLimitHeaders: {
    limit: number | null;
    remaining: number | null;
    reset: number | null;
  };
}

/**
 * Parse shadow rate limit error from HTTP response body.
 * Returns structured info if pattern matched.
 */
export function parseShadowRateLimitError(body: string): RateLimitErrorInfo | null {
  try {
    const json = JSON.parse(body);
    const error = json.error || json;
    
    if (error.code && typeof error.code === 'string') {
      return {
        code: error.code,
        message: error.message || '',
        retryAfter: null,  // Caller should extract from headers
        rateLimitHeaders: { limit: null, remaining: null, reset: null },
      };
    }
  } catch {
    // Not JSON, fall through
  }
  return null;
}

/**
 * Extract rate limit headers from HTTP response.
 */
export function parseRateLimitHeaders(headers: Record<string, string>): RateLimitHeaders {
  return {
    limit: parseInt(headers['x-ratelimit-limit'] || headers['X-RateLimit-Limit']) || null,
    remaining: parseInt(headers['x-ratelimit-remaining'] || headers['X-RateLimit-Remaining']) || null,
    reset: parseInt(headers['x-ratelimit-reset'] || headers['X-RateLimit-Reset']) || null,
    retryAfter: parseInt(headers['retry-after'] || headers['Retry-After']) || null,
  };
}
```

---

## 3. Prompt Compaction / Token-Efficiency

### 3.1 Problem

GitHub Support guidance in `Docs/ShadowRateLimits.md` points to **high token usage** as a major trigger for Copilot service-side rate limiting:

- long conversations
- pasted logs
- agent mode on premium models
- public-preview models with limited capacity

That makes repeated heavy resurrection attempts self-defeating. The better goal is to reduce token pressure and prefer fresh sessions when the existing session context is likely the problem.

### 3.2 Solution: Prompt Compaction and Safer Session Reset

```typescript
interface RemixStrategy {
  name: string;
  transform: (prompt: string) => string;
}

/**
 * Compaction strategies that reduce prompt weight without trying to bypass
 * GitHub service protections.
 */
const REMIX_STRATEGIES: RemixStrategy[] = [
  // 1. Deterministic whitespace normalization
  {
    name: 'normalize-whitespace',
    transform: (prompt) => {
      return prompt
        .replace(/\r\n/g, '\n')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    },
  },
  
  // 2. Remove obvious prompt bloat such as repeated blank lines
  {
    name: 'compact-structure',
    transform: (prompt) => {
      return prompt
        .split('\n')
        .map(line => line.trimEnd())
        .filter((line, index, all) => !(line === '' && all[index - 1] === ''))
        .join('\n')
        .trim();
    },
  },

  // 3. Directive templating to keep instructions concise and stable
  {
    name: 'directive-template',
    transform: (prompt) => {
      const cleaned = prompt
        .replace(/\s+/g, ' ')
        .trim();

      return `Resume the user's autonomous workflow safely and continue from the current repository state. ${cleaned}`;
    },
  },
];

/**
 * Get a remix strategy by name.
 */
export function getRemixStrategy(name: string): RemixStrategy | undefined {
  return REMIX_STRATEGIES.find(s => s.name === name);
}

/**
 * Remix a prompt using a specific strategy.
 */
export function remixPrompt(prompt: string, strategyName: string): string {
  const strategy = getRemixStrategy(strategyName);
  if (!strategy) {
    Logger.warn(`Unknown remix strategy: ${strategyName}, returning original`);
    return prompt;
  }
  return strategy.transform(prompt);
}

/**
 * Remix with a random strategy.
 */
export function remixPromptRandom(prompt: string): string {
  const strategy = REMIX_STRATEGIES[Math.floor(Math.random() * REMIX_STRATEGIES.length)];
  Logger.info(`Remixing prompt with strategy: ${strategy.name}`);
  return strategy.transform(prompt);
}
```

### 3.3 Configuration

```typescript
// In ResurrectConfig
interface ResurrectConfig {
  // ... existing fields ...
  
  // NEW: Prompt compaction
  promptCompactionEnabled: boolean;         // default: false
  promptCompactionStrategy: string;         // default: 'normalize-whitespace'
  promptCompactionMaxRetries: number;       // default: 2
  
  // Available strategies
  availableRemixStrategies: string[];      // ['normalize-whitespace', 'compact-structure', 'directive-template']
}
```

### 3.3 Guardrail

Do **not** try to evade or bypass GitHub rate limits by injecting random padding, invisible characters, homoglyph substitutions, or other anti-detection tricks. The supported direction is to reduce token use, shorten context, start a fresh session when appropriate, and switch to a less constrained model where available.

---

## 4. Fallback Model Array

### 4.1 Problem

Currently, `fallbackModel` is a single string. If that model is rate-limited, there's no next option.

### 4.2 Solution

```typescript
interface ResurrectConfig {
  // ... existing fields ...
  
  // REPLACE: Single fallback with ordered array
  fallbackModelChain: string[];             // default: [] — e.g., ['gpt-4o', 'claude-3-5-sonnet', 'gemini-1.5-pro']
  
  // NEW: Model-specific rate limit tracking
  modelRateLimitState: Map<string, ModelRateLimitInfo>;
}

interface ModelRateLimitInfo {
  lastError: string | null;           // Last error code for this model
  consecutiveFailures: number;        // Consecutive failures with this model
  lastAttempt: Date | null;
  cooldownUntil: Date | null;         // When this model becomes available again
}
```

### 4.2 Usage in Resurrection Engine

```typescript
class ResurrectionEngine {
  // ... existing code ...
  
  /**
   * Get the next available model from the fallback chain.
   * Skips models that are in cooldown.
   */
  getNextModel(currentModel: string | null): string | null {
    const chain = this.config.fallbackModelChain;
    if (chain.length === 0) {
      return this.config.fallbackModel || null;
    }
    
    // Find index to start from
    const startIndex = currentModel 
      ? (chain.indexOf(currentModel) + 1) 
      : 0;
    
    // Find first model not in cooldown
    for (let i = startIndex; i < chain.length; i++) {
      const model = chain[i];
      const state = this.getModelRateLimitState(model);
      
      if (state.cooldownUntil && state.cooldownUntil > new Date()) {
        Logger.info(`Model ${model} is in cooldown until ${state.cooldownUntil}`);
        continue;
      }
      
      return model;
    }
    
    // All models in cooldown, return first one (will respect cooldown)
    return chain[0];
  }
  
  /**
   * Record a rate limit failure for a specific model.
   */
  recordModelFailure(model: string, errorCode: string): void {
    let state = this.config.modelRateLimitState.get(model);
    if (!state) {
      state = { lastError: null, consecutiveFailures: 0, lastAttempt: null, cooldownUntil: null };
    }
    
    state.consecutiveFailures++;
    state.lastError = errorCode;
    state.lastAttempt = new Date();
    
    // Apply model-specific cooldown based on error severity
    const cooldownSeconds = this.getModelCooldownForError(errorCode);
    if (cooldownSeconds > 0) {
      state.cooldownUntil = new Date(Date.now() + cooldownSeconds * 1000);
      Logger.info(`Model ${model} entered cooldown for ${cooldownSeconds}s due to ${errorCode}`);
    }
    
    this.config.modelRateLimitState.set(model, state);
  }
  
  /**
   * Get cooldown duration based on error type.
   */
  getModelCooldownForError(errorCode: string): number {
    const cooldowns: Record<string, number> = {
      'user_weekly_rate_limited': 60 * 60 * 24 * 7,   // 1 week
      'user_daily_rate_limited': 60 * 60 * 24,         // 24 hours
      'user_hourly_rate_limited': 60 * 60,              // 1 hour
      'model_capacity_limited': 60 * 30,                // 30 minutes
      'model_rate_limited': 60 * 15,                    // 15 minutes
      'user_global_rate_limited': 60 * 10,               // 10 minutes
      'user_rate_limited': 60 * 5,                       // 5 minutes
      'quota_exceeded': 60 * 5,                          // 5 minutes
    };
    
    return cooldowns[errorCode.toLowerCase()] ?? 60;  // Default 1 minute
  }
}
```

---

## 5. HTTP Header Analysis from 429 Responses

### 5.1 What's in the Headers

When a 429 occurs, the response headers may contain:

```bash
HTTP/2 429
Content-Type: application/json
Retry-After: 3600        # Seconds to wait
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 1744800000
X-RateLimit-Resource: copilot
```

### 5.2 New Header Parser

```typescript
interface CopilotRateLimitHeaders {
  retryAfter: number | null;     // Seconds until retry allowed
  limit: number | null;          // Rate limit ceiling
  remaining: number | null;     // Requests remaining (usually 0)
  reset: number | null;          // Unix timestamp of reset
  resource: string | null;      // "copilot" — indicates this is Copilot-specific
  oAuthScopes: string | null;   // Token scopes (may reveal tier)
}

/**
 * Parse rate limit headers from a Copilot 429 response.
 */
export function parseCopilotRateLimitHeaders(
  headers: Record<string, string>
): CopilotRateLimitHeaders {
  const normalize = (h: string) => h.toLowerCase().replace(/-/g, '_');
  
  const get = (names: string[]): string | null => {
    for (const name of names) {
      const found = Object.keys(headers).find(k => normalize(k) === normalize(name));
      if (found) return headers[found];
    }
    return null;
  };
  
  const toInt = (v: string | null): number | null => {
    if (v === null) return null;
    const n = parseInt(v, 10);
    return isNaN(n) ? null : n;
  };
  
  return {
    retryAfter: toInt(get(['Retry-After', 'retry-after'])),
    limit: toInt(get(['X-RateLimit-Limit', 'x-ratelimit-limit'])),
    remaining: toInt(get(['X-RateLimit-Remaining', 'x-ratelimit-remaining'])),
    reset: toInt(get(['X-RateLimit-Reset', 'x-ratelimit-reset'])),
    resource: get(['X-RateLimit-Resource', 'x-ratelimit-resource']),
    oAuthScopes: get(['X-OAuth-Scopes', 'x-oauth-scopes']),
  };
}
```

### 5.3 State Persistence

```typescript
interface RateLimitState {
  // Per-token rate limit awareness
  githubApi: {
    remaining: number;
    reset: number;
    lastChecked: Date;
  };
  
  // Per-model shadow rate limit state
  models: Record<string, {
    lastErrorCode: string | null;
    lastErrorTime: Date | null;
    cooldownUntil: Date | null;
    consecutiveFailures: number;
  }>;
  
  // Global Copilot state
  copilot: {
    isGloballyLimited: boolean;
    globalLimitCode: string | null;
    globalCooldownUntil: Date | null;
  };
}

/**
 * Persist rate limit state to extension globalState.
 * Allows resuming after VS Code restart.
 */
export async function saveRateLimitState(
  context: vscode.ExtensionContext,
  state: RateLimitState
): Promise<void> {
  await context.globalState.update('copilot-resurrect.rateLimitState', state);
}

export async function loadRateLimitState(
  context: vscode.ExtensionContext
): Promise<RateLimitState | null> {
  return context.globalState.get<RateLimitState>('copilot-resurrect.rateLimitState') ?? null;
}
```

---

## 6. Enhanced Retry Logic

### 6.1 Current Problem

The current retry mechanism uses `workbench.action.chat.retry` which is not accessible in VS Code 1.112.0. The retry path falls back to ignition-prompt injection, which is the correct behavior.

### 6.2 Retry Strategies Implemented

```typescript
type RetryAction = 'wait' | 'new_session' | 'remix_prompt' | 'retry_in_place';

interface RetryStrategy {
  action: RetryAction;
  targetModel?: string;       // logged and suggested, not executed
  remixStrategy?: string;
  waitSeconds?: number;
}

/**
 * Determine the best retry strategy based on the error.
 * Note: 'change_model' is logged/suggested but NOT executed programmatically.
 * See Section 6.3 for the model-switching limitation.
 */
export function determineRetryStrategy(
  error: DetectedError,
  headers: CopilotRateLimitHeaders,
  state: RateLimitState
): RetryStrategy {
  // If Retry-After header is present, always wait
  if (headers.retryAfter && headers.retryAfter > 0) {
    return { action: 'wait', waitSeconds: headers.retryAfter };
  }

  // If model-specific error, suggest a different model (execute fresh session as proxy)
  if (error.type === 'rate_limit') {
    const errorCode = normalizeErrorCode(extractErrorCode(error.pattern));

    // Critical errors — longer wait
    if (['user_weekly_rate_limited', 'user_daily_rate_limited'].includes(errorCode)) {
      return { action: 'wait', waitSeconds: getCooldownForError(errorCode) };
    }

    // Model-specific — log suggestion and start new session as proxy for model switch
    if (errorCode?.startsWith('model_')) {
      return {
        action: 'new_session',
        targetModel: getNextAvailableModel(errorCode), // suggested in logs, not executed
      };
    }

    // Global limit — wait then retry with fresh session
    if (errorCode?.startsWith('user_global_')) {
      return { action: 'new_session' };
    }

    // Default: fresh session (natural Copilot model re-route)
    return { action: 'new_session' };
  }

  // Server error — simple retry via new session
  return { action: 'new_session' };
}
```

### 6.3 Model-Switching Limitation (Critical)

**Finding:** There is no public VS Code API to programmatically select a specific model for Copilot Chat sessions.

Evidence:
- `github.copilot.chat.openModelPicker` — opens the picker UI only, no arguments accepted
- No `selectModel(modelId)` command exists in the public API
- Internal `selectModel` methods in Copilot Chat are not accessible to other extensions

**Current workaround:** `startNewSession: true` creates a fresh session context, which gives Copilot's internal router a clean slate. This is the correct behavior for model-rate-limited scenarios because:
1. Fresh sessions avoid repeating the heavy context that triggered the limit
2. Copilot's router re-evaluates model selection for new sessions
3. Prompt compaction further reduces token pressure

**Claude Agent configs:** For agent-mode sessions, per-agent model configs (`.claude/agents/*.md`) with `model:` frontmatter CAN specify a model. Switching agent mode via `workbench.action.chat.switchChatMode` can reach these if pre-configured. This is the only path that truly binds a model to an agent.

/**
 * Execute retry with model switching.
 */
async function executeSmartRetry(
  strategy: RetryStrategy,
  engine: ResurrectionEngine
): Promise<boolean> {
  switch (strategy.action) {
    case 'wait':
      Logger.info(`Waiting ${strategy.waitSeconds}s before retry`);
      await sleep(strategy.waitSeconds! * 1000);
      return engine.resurrect(engine.config, false, 'rate_limit');
      
    case 'change_model':
      const newModel = strategy.targetModel!;
      Logger.info(`Switching to model: ${newModel}`);
      // Update the session's model selection before retry
      await vscode.commands.executeCommand('workbench.action.chat.selectModel', newModel);
      return engine.resurrect(engine.config, false, 'rate_limit');
      
    case 'remix_prompt':
      Logger.info(`Remixing prompt with strategy: ${strategy.remixStrategy}`);
      // The remix will be applied in the next resurrection call
      return engine.resurrect(engine.config, false, 'rate_limit');
      
    case 'retry':
      return engine.resurrect(engine.config, false, 'rate_limit');
      
    case 'new_session':
      // Start fresh session to clear context
      await vscode.commands.executeCommand('workbench.action.chat.newSession');
      return engine.resurrect(engine.config, false, 'manual');
  }
}
```

---

## 7. Status Bar Integration

### 7.1 New Status Indicators

```typescript
class RateLimitStatusBar {
  private item: vscode.StatusBarItem;
  
  constructor() {
    this.item = vscode.window.createStatusBarItem(
      'copilot-resurrect.ratelimit',
      vscode.StatusBarAlignment.Left,
      100
    );
    this.item.name = 'Copilot Rate Limit';
    this.item.text = '$(debug-pause) Copilot: OK';
    this.item.tooltip = 'No rate limits detected';
  }
  
  update(state: RateLimitState): void {
    if (state.copilot.isGloballyLimited) {
      const remaining = state.copilot.globalCooldownUntil 
        ? Math.round((state.copilot.globalCooldownUntil.getTime() - Date.now()) / 1000)
        : 0;
      this.item.text = `$(warning) Copilot: ${state.copilot.globalLimitCode} (${remaining}s)`;
      this.item.color = new vscode.ThemeColor('errorForeground');
    } else if (state.githubApi.remaining < 10) {
      this.item.text = `$(warning) GitHub API: ${state.githubApi.remaining} calls left`;
      this.item.color = new vscode.ThemeColor('warningForeground');
    } else {
      this.item.text = '$(debug-pause) Copilot: OK';
      this.item.color = undefined;
    }
  }
  
  show(): void {
    this.item.show();
  }
  
  hide(): void {
    this.item.hide();
  }
}
```

---

## 8. Implementation Phases

### Phase 1: Shadow Rate Limit Detection (Priority: HIGH)
- [x] Add error patterns to `errorDetector.ts`
- [x] Add structured JSON-like error parsing for `error.code` / `message`
- [x] Add header parsing for `Retry-After`, `X-RateLimit-*`, and request IDs
- [x] Add machine-readable rate-limit severity/scope/cooldown metadata
- [x] Compile and validate the implementation locally

### Phase 2: Model Fallback Chain (Priority: HIGH)
- [x] Add `fallbackModelChain: string[]` in config with legacy `fallbackModel` migration/deduping
- [x] Add command/UI support to pick an ordered fallback chain
- [x] Implement recovery-time fallback-model suggestion logic in `ResurrectionEngine`
- [x] Persist the suggested fallback model in structured rate-limit state
- [x] Persist per-model cooldown state and skip cooling-down models when suggesting the next fallback
- [ ] Implement unattended model switching if a supported VS Code/Copilot hook becomes available

### Phase 3: Smart Retry with Model Switching (Priority: HIGH)
- [x] Handle `Retry-After` / explicit cooldown metadata properly
- [x] Prefer a fresh session for shadow-rate-limit recovery to avoid replaying heavy context
- [ ] Integrate a supported automatic model-switch path if one becomes available
- [ ] Validate whether `github.copilot.chat.openModelPicker` can be safely automated

### Phase 4: Prompt Compaction (Priority: MEDIUM)
- [x] Replace earlier prompt-obfuscation direction with token-pressure-safe compaction
- [x] Add compaction strategies and config options
- [x] Apply compaction during rate-limit recovery when enabled
- [x] Bias rate-limit recovery toward fresh sessions

### Phase 5: State Persistence (Priority: MEDIUM)
- [x] Add persisted rate-limit state model
- [x] Implement `saveRateLimitState()` / `loadRateLimitState()`
- [x] Surface persisted state in the extension status output
- [x] Add state cleanup after successful non-error resurrection

### Phase 6: Status Bar Enhancement (Priority: LOW)
- [x] Integrate shadow-rate-limit cooldown display into the status bar
- [x] Show persisted shadow cooldown code + remaining time
- [ ] Add optional explicit show/hide configuration if desired later

---

## 9. Configuration Schema Changes

```typescript
// New full config additions
interface ResurrectConfig {
  // ... existing fields (keep for backward compatibility) ...
  
  // === SHADOW RATE LIMIT ===
  shadowRateLimitDetectionEnabled: boolean;  // default: true
  
  // === MODEL FALLBACK CHAIN ===
  fallbackModelChain: string[];               // default: []
  modelCooldownMinutes: number;                // default: 5
  
  // === PROMPT REMIXING ===
  promptRemixingEnabled: boolean;              // default: false
  promptRemixingStrategy: string;              // default: 'random'
  promptRemixingMaxAttempts: number;          // default: 3
  
  // === SMART RETRY ===
  smartRetryEnabled: boolean;                  // default: true
  respectRetryAfterHeader: boolean;           // default: true
  
  // === STATUS BAR ===
  showRateLimitStatusBar: boolean;             // default: true
}
```

---

## 10. Key Error → Action Mapping

| Error Code | Action | Reason |
|------------|--------|--------|
| `user_weekly_rate_limited` | Wait 1 week + notify user | Can't fix, must wait |
| `user_daily_rate_limited` | Wait 24h + suggest new conversation | Can't fix quickly |
| `user_hourly_rate_limited` | Wait 1h + offer model switch | Cool-down + alternative |
| `user_global_rate_limited` | Wait 10min + remix prompt | Service-level protection |
| `model_rate_limited` | Switch model from chain | Model-specific limit |
| `model_capacity_limited` | Switch model + longer cooldown | Capacity exhausted |
| `quota_exceeded` | Wait 5min + remix | Generic quota hit |
| `too_many_requests` | Wait + exponential backoff | Generic overload |

---

## 11. Evidence-Based Answers to the Open Questions

### 11.1 How do we detect which model is being used?

**Answer:** not reliably from the current public extension surface for an already-running Copilot Chat session.

Evidence:

- `src/extension.ts` currently only stores `preferredModel` / `fallbackModel`; it does not read the active chat-session model.
- The VS Code Chat API docs indicate that a chat participant receives the already-selected model as `request.model`, but that only applies **inside a participant request handler**, not to an external watchdog extension injecting prompts into GitHub Copilot Chat.
- The VS Code Language Model API docs show `vscode.lm.selectChatModels(...)` can enumerate models, but that is model discovery/selection for extension requests, not a getter for Copilot Chat's current dropdown selection.

**Practical implication:**

- Track the model the extension *asked* the user to use, or the model it explicitly chooses in a supported path.
- If we cannot read the active session model, treat “last attempted model” as inferred state and persist it ourselves.

### 11.2 Can the extension rely on the Copilot token to call `GET /rate_limit`?

**Answer:** not safely or portably based on the currently visible supported surfaces.

Evidence:

- Public VS Code docs for the Language Model API talk about user consent to model access, but do not expose the underlying Copilot auth token to arbitrary extensions.
- Searching the installed Copilot/Copilot Chat manifests did **not** surface a supported authentication provider/scope contract that this extension could depend on for reusing Copilot's token to call GitHub REST APIs.

**Practical implication:**

- Treat GitHub REST rate-limit checks as an optional, separately-configured capability rather than assuming access to Copilot's own token.
- The extension should still parse and act on Copilot-side 429 payloads even with no REST token at all.

### 11.3 Is there a reliable VS Code/Copilot command to change the active chat model before retry?

**Answer:** there is no public built-in command documented for this, and the current extension does not have one wired.

Evidence:

- `src/resurrectionEngine.ts` explicitly notes `workbench.action.chat.retry` is unavailable and falls back to ignition-prompt recovery.
- Public VS Code built-in command docs do not list a generic chat model selection command.
- The installed `github.copilot-chat` manifest exposes `github.copilot.chat.openModelPicker`, but the surfaced configuration/docs evidence we found clearly references **completion** model selection and per-agent model overrides (`github.copilot.chat.askAgent.model`, `github.copilot.chat.implementAgent.model`, etc.), not a documented “switch the current Copilot Chat session's model and resend” API.

**Practical implication:**

- We should prototype `github.copilot.chat.openModelPicker` only as an exploratory path, not as a guaranteed production dependency.
- The primary supported strategy should be: persist model intent, prefer fresh-session recovery, and use supported agent-model settings where they apply.

### 11.4 Should we keep the earlier prompt-remixing / obfuscation idea?

**Answer:** no.

Support guidance points toward token pressure and capacity constraints, not a documented pattern-match on repeated strings. The safer and more supportable direction is prompt compaction, shorter sessions, and model-aware fallback—not anti-detection prompt mutation.

---

## 12. Tracking Issues

- `#4` Umbrella: shadow rate limit awareness and intelligent Copilot recovery
- `#3` Parse custom Copilot 429 payloads and persist rate-limit state
- `#2` Implement model-aware retry and a real fallback model chain
- `#5` Reduce token pressure with new-session heuristics and prompt compaction

---

## 13. Open Questions

1. **Command validation** — Does `github.copilot.chat.openModelPicker` accept arguments or only open UI? We need runtime validation before depending on it.
2. **Header capture path** — What is the best supported way to capture full Copilot 429 headers from session artifacts or logs, if any?
3. **Model attribution** — Do any real Copilot 429 payloads include enough metadata to identify the failed model directly?
4. **Session length heuristics** — What is the most reliable local signal for “context is too large, start a fresh chat”? 

---

*Plan created for implementation. Update status as phases are completed.*
