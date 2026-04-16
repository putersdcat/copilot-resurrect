# Shadow Rate Limits — Real Error Reference

> **Note:** This page documents actual error patterns and HTTP response data observed from Copilot Chat 429 responses, plus investigation findings on model-switching capabilities.

## Real Error Response Format

When a shadow rate limit is hit, Copilot Chat returns a JSON body like:

```json
{
  "error": {
    "message": "Sorry, you've exceeded your weekly rate limit...",
    "code": "user_weekly_rate_limited"
  }
}
```

With HTTP response headers:

```
HTTP/2 429
Content-Type: application/json
Retry-After: 3600
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 1744800000
X-RateLimit-Resource: copilot
```

---

## Known Shadow Rate Limit Error Codes

| Code | Severity | Cooldown | Notes |
|------|----------|----------|-------|
| `user_weekly_rate_limited` | Critical | ~1 week | Full weekly quota exhausted |
| `user_daily_rate_limited` | High | ~24h | Full daily quota exhausted |
| `user_hourly_rate_limited` | Medium | ~1h | Full hourly quota exhausted |
| `user_global_rate_limited` | High | ~10min | Global service protection |
| `user_global_rate_limited:pro` | High | ~10min | Tiered variant (Pro users) |
| `model_rate_limited` | High | ~15min | Model-specific rate limit |
| `model_capacity_limited` | High | ~30min | Model at capacity |
| `quota_exceeded` | Medium | ~5min | Generic quota signal |
| `user_rate_limited` | Medium | ~5min | Generic user-level limit |
| `too_many_requests` | Low | ~1min | Generic 429 signal |
| `rate_limited` (variant: `error_code: rate_limited`) | Medium | ~5min | Normalized form |
| `error_code: rate_limited` | Medium | ~5min | Seen in some Copilot responses |

---

## Model Switching Investigation (Issue #2 Findings)

### What VS Code/Copilot Actually Exposes

After examining the Copilot Chat extension source (`vscode-copilot-chat`):

- `github.copilot.chat.openModelPicker` — opens the model picker **UI dropdown only**, no argument support
- `github.copilot.openModelPicker` — completions model picker (different surface)
- Internal `selectModel(modelId)` methods — exist in the Claude agents subsystem but are **not accessible** to other extensions
- `vscode.lm.selectChatModels({ vendor: 'copilot' })` — **can enumerate** available models (used by `getAvailableModels()`)
- No public `selectModel(modelId)` command or API exists

### Verdict: No Unattended Model Switching Available

The Copilot Chat public API surface does not expose a way to programmatically select a specific model for a chat session. The model picker is always a **user-interaction UI flow**.

### Workarounds Available

1. **Claude Agent configs** (`.claude/agents/*.md`) — These CAN specify a per-agent model in YAML frontmatter (`model: gpt-4o`). If you pre-create multiple agent configs and configure `agentMode` to point at them, `workbench.action.chat.switchChatMode` can switch between them. This only works for **agent mode** sessions.

2. **Fresh session + prompt compaction** — When `startNewSession: true`, a fresh session gives Copilot's router a clean context slate. Combined with prompt compaction (`promptCompactionEnabled`), this reduces the token pressure that often triggers model-specific limits. This is the **correct unattended fallback**.

3. **Manual notification** — When a model-specific rate limit is detected, show the user a message suggesting they manually switch the model in the chat UI. This is the graceful degradation path already implemented.

---

## Detected Error Patterns (from `errorDetector.ts`)

```typescript
SHADOW_RATE_LIMIT_PATTERNS includes:
// Weekly/Daily/Hourly quotas
/user_weekly_rate_limited/i          → critical, 7 days
/user_daily_rate_limited/i           → high, 24h
/user_hourly_rate_limited/i           → medium, 1h

// Global limits
/user_global_rate_limited(?::[a-z0-9_-]+)?/i  → high, 10min

// Model-specific
/model_capacity_limited/i             → high, 30min
/model_rate_limited/i                 → high, 15min

// Generic
/quota_exceeded/i                     → medium, 5min
/too_many_requests/i                  → low, 1min
/user_rate_limited/i                  → medium, 5min

// Human-readable messages
/you have been rate[- ]limited/i      → medium, 5min
/exhausted this model'?s rate limit/i → high, 15min

// Suggestion messages
/Please try a different model/i        → high, 15min  (elevated — strong model-switch signal)
```

---

## Error Code Normalization

Error codes from Copilot responses can appear in multiple formats:

- `user_weekly_rate_limited` (standard JSON `error.code`)
- `error_code: rate_limited` (human-readable in chat content)
- `rate_limited` (normalized internal form)

All variants are normalized via `normalizeErrorCode()` before fallback model selection decisions.

---

## GitHub Support Reference

---

Thanks for writing in to GitHub Support!

I completely understand your frustration with hitting rate limits. The good news is we're actively working to improve this experience for you and all GitHub Copilot users. Your rate limit should reset automatically, but I wanted to provide some context on why this happens and how you can work around it.

While Copilot Pro, Pro+, Business, and Enterprise plans have included premium requests, there are still global rate limits that apply to all Copilot plans which are unrelated to your premium request balance or budgets. These protect the stability of the service while capacity is limited and cannot be modified by GitHub Support.

Our biggest challenge right now is securing more capacity for our premium models. Some of these models aren't running on our primary infrastructure, and we're working diligently with cloud providers to increase availability.

The Copilot rate limits will often be triggered by a significant amount of tokens being used at once.

Here are a few ways this can happen:

Entering large log texts directly into Copilot Chat
Maintaining long conversations with GitHub Copilot
Having a moderate conversation that at some point contains a log paste
Extended use of Agent mode, particularly with [premium models]
Use of models in public preview, which have limited capacity. See [supported models].
A simple way to reduce the amount of tokens being used would be to regularly start a new conversation when moving onto a new topic. As a conversation with GitHub Copilot grows, all the prior context and messages are still included which can result in many tokens being used.

Rapidly iterating and complex AI features, like agentic AI can use a lot of tokens rapidly. Using premium models with agentic features can quickly exhaust rate limits. You might need to change models depending on the specific task you're working on, for example using the default model for most tasks and then starting a new conversation targeted on specific complex tasks with a more advanced model. See [Choosing the right AI model for your task] in the GitHub Docs for more details.

I hope these pointers are helpful. Our team is eager to roll out greater rate limits, and is constantly working on increasing capacity for all GitHub Copilot users. While third-party provisioned models have more limited resources, we're actively working to improve this situation too.

We appreciate your patience as we Accelerate Performance across our AI-powered developer platform.