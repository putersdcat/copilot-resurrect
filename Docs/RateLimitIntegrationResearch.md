# Rate Limit Integration Research for copilot-resurrect

**Date:** April 16, 2026  
**Purpose:** Research findings for integrating GitHub API rate limit awareness into the copilot-resurrect tool

---

## Executive Summary

The `copilot-resurrect` tool needs to integrate GitHub API rate limit awareness to make intelligent decisions about when and how to attempt session resurrection. This document outlines the relevant GitHub APIs, headers, and strategies for implementing a smart rate-limit-aware resurrection module.

---

## 1. GitHub REST API Rate Limit Endpoint

### Endpoint: `GET /rate_limit`

**Documentation:** https://docs.github.com/en/rest/rate-limit/rate-limit

**Key Points:**
- **Does NOT count against your rate limit** when checking (important for self-monitoring)
- Returns detailed rate limit status for all resource categories

### Response Schema

```json
{
  "resources": {
    "core": {
      "limit": 5000,
      "used": 1,
      "remaining": 4999,
      "reset": 1691591363
    },
    "search": {
      "limit": 30,
      "used": 12,
      "remaining": 18,
      "reset": 1691591091
    },
    "graphql": {
      "limit": 5000,
      "used": 7,
      "remaining": 4993,
      "reset": 1691593228
    },
    "integration_manifest": { ... },
    "code_scanning_upload": { ... },
    "actions_runner_registration": { ... },
    "scim": { ... },
    "dependency_snapshots": { ... },
    "code_search": { ... },
    "code_scanning_autofix": { ... }
  }
}
```

### Key Fields per Resource

| Field | Description |
|-------|-------------|
| `limit` | Maximum requests allowed in the time window |
| `used` | Number of requests used in current window |
| `remaining` | Requests left in current window |
| `reset` | Unix timestamp when the rate limit resets |

### Recommended Implementation

The `core` resource is the primary one for Copilot Chat API calls. For resurrection attempts, we should:

1. **Always check before attempting resurrection** - if `remaining < threshold`, defer
2. **Track our own usage** - increment `used` on each API call we make
3. **Use `reset` timestamp** - calculate wait time until safe to retry

---

## 2. GitHub Copilot Rate Limits

**Documentation:** https://docs.github.com/en/copilot/concepts/rate-limits

### Types of Rate Limits

1. **Service-level rate limits** - Temporary protections for overall reliability (global/weekly)
2. **Plan-based limits** - Model-specific usage limits based on Copilot plan (Individual, Business, Enterprise)

### What Happens When Rate Limited

When rate limited, Copilot returns errors and users see:
- Error messages indicating rate limit was hit
- May temporarily lose access to certain features/models

### Recovery Strategies (from GitHub docs)

1. **Wait and retry** - Rate limits are temporary
2. **Check usage patterns** - Adjust frequency of requests
3. **Change model** - Select models may have different limits
4. **Upgrade plan** - More capacity on higher tiers
5. **Contact Support** - If limit impacts legitimate use

---

## 3. Copilot Usage Metrics API

**Documentation:** https://docs.github.com/en/rest/copilot/copilot-usage-metrics

> **Note:** These endpoints are for **enterprise/organization-level metrics** and require special permissions. They provide aggregated usage reports, not real-time status. For our use case (individual session resurrection), these are **NOT directly applicable** but useful to understand for enterprise deployments.

### Endpoints Available

| Endpoint | Purpose |
|----------|---------|
| `GET /enterprises/{enterprise}/copilot/metrics/reports/enterprise-1-day` | Daily enterprise metrics |
| `GET /enterprises/{enterprise}/copilot/metrics/reports/enterprise-28-day/latest` | 28-day rolling enterprise report |
| `GET /orgs/{org}/copilot/metrics/reports/organization-1-day` | Daily org metrics |
| `GET /orgs/{org}/copilot/metrics/reports/organization-28-day/latest` | 28-day rolling org report |

### Required Permissions

- Enterprise: `manage_billing:copilot` or `read:enterprise`
- Organization: `read:org` with "Organization Copilot metrics" permission
- Fine-grained tokens need specific read permissions

### Response Format

```json
{
  "download_links": ["https://example.com/copilot-usage-report-1.json"],
  "report_day": "2025-07-01"
}
```

Reports are downloaded as JSON files - **not real-time data**.

---

## 4. HTTP Headers for Rate Limit Awareness

### Standard GitHub Rate Limit Headers

When making any GitHub API request, responses include:

| Header | Description |
|--------|-------------|
| `X-RateLimit-Limit` | Request quota for current user |
| `X-RateLimit-Remaining` | Remaining requests in current window |
| `X-RateLimit-Reset` | Unix timestamp when limit resets |
| `X-RateLimit-Used` | Requests used in current window |
| `X-RateLimit-Resource` | The rate limit resource category |

### Rate Limit Exceeded Response

When limit is exceeded, GitHub returns:

| Header | Description |
|--------|-------------|
| `Retry-After` | Seconds to wait before retrying |
| `X-RateLimit-Limit` | Original limit |
| `X-RateLimit-Remaining` | 0 |
| `X-RateLimit-Reset` | Reset timestamp |

### HTTP Status Codes

| Code | Meaning |
|------|---------|
| `200` | OK - request succeeded |
| `403` | Forbidden - likely rate limited or no permission |
| `429` | Too Many Requests - explicit rate limit hit |
| `503` | Service Unavailable - may indicate rate limiting |

---

## 5. Integration Strategy for copilot-resurrect

### Architecture Recommendation

```
┌─────────────────────────────────────────────────────────┐
│                  RateLimitMonitor                        │
│  ┌─────────────────┐  ┌──────────────────────────────┐  │
│  │ rateLimitState  │  │   GitHubApiClient            │  │
│  │ - remaining     │◄─┤   - GET /rate_limit           │  │
│  │ - reset         │  │   - Response parsing         │  │
│  │ - used          │  │   - Header extraction        │  │
│  └─────────────────┘  └──────────────────────────────┘  │
│           │                       │                      │
│           ▼                       ▼                      │
│  ┌─────────────────────────────────────────────┐        │
│  │          ResurrectionEngine                  │        │
│  │  - shouldAttempt(status) → boolean           │        │
│  │  - getWaitTime(status) → seconds             │        │
│  │  - calculateBackoff(attempts) → ms          │        │
│  └─────────────────────────────────────────────┘        │
└─────────────────────────────────────────────────────────┘
```

### Key Functions to Implement

1. **`checkRateLimitStatus()`** - Call `GET /rate_limit` to get current state
2. **`shouldAttemptResurrection(status)`** - Decision logic based on:
   - `remaining` count vs. threshold (e.g., < 10 = defer)
   - Time until `reset` vs. max wait tolerance
   - Current backoff state
3. **`calculateBackoff(attemptCount, rateLimitReset)`** - Exponential backoff with rate limit awareness
4. **`onRateLimitHit(retryAfter)`** - Handle 429 responses, extract `Retry-After`

### Suggested Thresholds

| Scenario | Action |
|----------|--------|
| `remaining > 100` | Safe to proceed |
| `remaining 10-100` | Proceed with caution, don't batch |
| `remaining < 10` | Defer resurrection, show status |
| `remaining == 0` | Wait for `reset` timestamp |
| `429 received` | Respect `Retry-After`, enter backoff |

### Backoff Strategy

```
Base delay = 1000ms (1 second)
Max delay = 5 minutes
Multiplier = 2x per failed attempt

If rate limit hit:
  delay = max(delay, Retry-After seconds * 1000)
  
Next attempt delay = min(delay * multiplier, max_delay)
```

---

## 6. Error Detection Integration

The existing `errorDetector.ts` should be extended to recognize:

### Rate Limit Errors

- HTTP 429 responses
- HTTP 403 with `rate_limit` or `RATE_LIMIT_LIMIT_EXCEEDED` in body
- Specific error codes from Copilot API

### Error Message Patterns

```typescript
const RATE_LIMIT_PATTERNS = [
  /rate.limit.exceeded/i,
  /rate.limit/i,
  /429/i,
  /too.many.requests/i,
  /retry.after/i,
  /RATE_LIMIT_LIMIT_EXCEEDED/i
];
```

---

## 7. Configuration Options

```typescript
interface RateLimitConfig {
  // Minimum remaining requests before warning
  warningThreshold: number;        // default: 100
  
  // Minimum remaining requests before blocking resurrection
  blockThreshold: number;          // default: 10
  
  // Maximum time to wait for rate limit reset (ms)
  maxWaitTime: number;             // default: 300000 (5 min)
  
  // Base backoff delay when rate limited (ms)
  baseBackoffDelay: number;        // default: 1000
  
  // Maximum backoff delay (ms)
  maxBackoffDelay: number;         // default: 300000
  
  // Whether to check rate limit before every attempt
  preCheckEnabled: boolean;        // default: true
  
  // How often to poll rate limit status (ms)
  statusPollInterval: number;      // default: 30000
}
```

---

## 8. Implementation Priority

### Phase 1: Core Rate Limit Detection
1. Add `RateLimitInfo` interface to `config.ts`
2. Implement `checkRateLimit()` function using `GET /rate_limit`
3. Update `errorDetector.ts` to recognize 429/403 rate limit errors
4. Parse `Retry-After` header when present

### Phase 2: Smart Resurrection Logic
1. Add `shouldAttempt()` decision logic to `resurrectionEngine.ts`
2. Implement exponential backoff with rate limit awareness
3. Add configuration thresholds to `config.ts`

### Phase 3: Status Reporting
1. Add rate limit status to status bar indicators
2. Log rate limit warnings before blocking resurrection
3. Show estimated wait time to user

---

## 9. API Endpoints Summary

| What | Endpoint | Auth | Cost |
|------|----------|------|------|
| Check rate limit | `GET /rate_limit` | Any | **Free** (doesn't count) |
| Copilot metrics (enterprise) | `GET /enterprises/{e}/copilot/metrics/...` | Enterprise admin | Not applicable |
| Copilot metrics (org) | `GET /orgs/{o}/copilot/metrics/...` | Org admin | Not applicable |

---

## 10. References

- [GitHub REST API Rate Limit](https://docs.github.com/en/rest/rate-limit/rate-limit?apiVersion=2026-03-10)
- [GitHub Copilot Rate Limits](https://docs.github.com/en/copilot/concepts/rate-limits)
- [GitHub Copilot Usage Metrics API](https://docs.github.com/en/rest/copilot/copilot-usage-metrics?apiVersion=2026-03-10)
- [Best practices for REST API rate limits](https://docs.github.com/en/rest/guides/best-practices-for-using-the-rest-api)
- [GitHub GraphQL API rate limits](https://docs.github.com/en/graphql/overview/resource-limitations#rate-limit)

---

## 11. Live API Test Results (April 16, 2026)

### Rate Limit Endpoint (`GET /rate_limit`)

**Headers returned:**
```
HTTP/1.1 200 OK
X-RateLimit-Limit: 60
X-RateLimit-Remaining: 60
X-RateLimit-Used: 0
X-RateLimit-Resource: core
X-RateLimit-Reset: 1776336510
```

**Response body:**
```json
{
  "resources": {
    "code_search": { "limit": 60, "remaining": 60, "reset": 1776336510, "used": 0 },
    "core": { "limit": 60, "remaining": 60, "reset": 1776336510, "used": 0 },
    "graphql": { "limit": 0, "remaining": 0, "reset": 1776336510, "used": 0 },
    "integration_manifest": { "limit": 5000, "remaining": 5000, "reset": 1776336510, "used": 0 },
    "search": { "limit": 10, "remaining": 10, "reset": 1776332970, "used": 0 }
  },
  "rate": { "limit": 60, "remaining": 60, "reset": 1776336510, "used": 0 }
}
```

**Key observations:**
- `core` resource shows `limit: 60` for unauthenticated (or lower-tier) requests
- `graphql` shows `limit: 0` - requires special authentication
- `reset` is a Unix timestamp (seconds since epoch)
- The rate limit headers are present on ALL API responses (not just rate_limit endpoint)

### Copilot Chat-Specific Errors Observed

**User-reported weekly rate limit error:**
```json
{
  "error": {
    "message": "Sorry, you've exceeded your weekly rate limit. Please review our [Terms of Service](...).",
    "code": "user_weekly_rate_limited"
  }
}
```

This error is **NOT** the same as standard HTTP 429. It comes from the Copilot Chat API itself with a structured `error.code` field. Key pattern: `user_weekly_rate_limited`

**Additional rate limit patterns to detect:**
```typescript
const RATE_LIMIT_PATTERNS = [
  /you have been rate[- ]limited/i,           // Already in errorDetector.ts
  /exhausted this model'?s rate limit/i,     // Already in errorDetector.ts
  /error[_ ]code:\s*rate[_ ]limited/i,       // Already in errorDetector.ts
  /Please try a different model/i,            // Already in errorDetector.ts
  // NEW patterns needed:
  /user_weekly_rate_limited/i,                // <-- Weekly Copilot limit (MISSING)
  /rate.limit.exceeded/i,                     // <-- Generic pattern (MISSING)
  /429/i,                                     // <-- HTTP status in body (MISSING)
  /too.many.requests/i,                       // <-- Generic pattern (MISSING)
];
```

### Rate Limit Header Behavior

Each API response includes these headers when rate limit is relevant:
```
X-RateLimit-Limit: 60
X-RateLimit-Remaining: 59    <-- decrements with each request
X-RateLimit-Used: 1
X-RateLimit-Resource: core
X-RateLimit-Reset: 1776336523
```

**Important:** When `X-RateLimit-Remaining` drops below threshold (e.g., 10), the tool should stop making API calls and wait for reset.

### Copilot Usage Metrics API Tests

All Copilot metrics endpoints returned **401 Unauthorized** without proper authentication:

| Endpoint | Result | Response |
|----------|--------|----------|
| `GET /orgs/{org}/copilot/metrics/reports/organization-1-day` | 401 | `{"message": "Requires authentication", ...}` |
| `GET /enterprises/{enterprise}/copilot/metrics/reports/enterprise-1-day` | 401 | `{"message": "Requires authentication", ...}` |
| `GET /orgs/{org}/copilot/metrics/reports/organization-28-day/latest` | 401 | `{"message": "Requires authentication", ...}` |
| `GET /copilot/metrics` | 404 | Not Found |
| `GET /copilot/v2/tokens` | 404 | Not Found |
| `GET /copilot/usage` | 404 | Not Found |
| `GET /copilot/models` | 404 | Not Found |
| `GET /copilot/modellicenses` | 404 | Not Found |

**Key findings:**
- All Copilot **metrics endpoints require authentication** with appropriate org/enterprise permissions
- No publicly accessible Copilot usage or model endpoints exist at the `GET /copilot/*` level
- The metrics API is designed for **enterprise/org admins** to download usage reports, not for real-time monitoring

**Implication for copilot-resurrect:**
The Copilot Usage Metrics API is **NOT useful** for our tool because:
1. It requires org/enterprise admin permissions that typical users don't have
2. It returns download links to reports, not real-time data
3. It's meant for billing/usage analysis, not session management

The **`GET /rate_limit`** endpoint remains the primary useful API for rate limit awareness.

---

## 12. Integration Findings

### Current Codebase State

**errorDetector.ts** already has:
- Rate limit pattern detection (4 patterns)
- Server error detection
- Content filtering detection
- TAIL_BYTES = 4096 for efficient scanning

**resurrectionEngine.ts** already has:
- Exponential backoff: `base * 2^consecutive` (capped at max)
- Daily restart counter (persisted in globalState)
- Consecutive rate limit tracking
- Cooldown timer with tick callback for status bar

**config.ts** already has:
- `rateLimitCooldownBaseSeconds: 30` (default)
- `rateLimitCooldownMaxSeconds: 600` (default, 10 minutes)

### What's MISSING

1. **No GitHub API rate limit check** - Tool doesn't call `GET /rate_limit` to proactively check before attempting resurrection
2. **No `Retry-After` header handling** - When receiving 429, should respect the Retry-After value
3. **`user_weekly_rate_limited` pattern missing** - The specific error from Copilot Chat API isn't detected
4. **No per-resource threshold checking** - Doesn't differentiate between resources that matter for Copilot vs. those that don't
5. **No proactive rate limit monitoring** - Only reacts to errors, doesn't prevent them

### Recommended Immediate Updates

```typescript
// config.ts - Add new configuration options
interface RateLimitConfig {
  // ... existing fields ...
  
  // NEW: GitHub API rate limit thresholds
  githubApiWarningThreshold: number;     // default: 10 (remaining)
  githubApiBlockThreshold: number;       // default: 5 (remaining)
  checkRateLimitBeforeAttempt: boolean;  // default: true
  
  // NEW: Weekly Copilot limit handling  
  weeklyLimitCooldownMinutes: number;    // default: 60 (1 hour)
}
```

```typescript
// errorDetector.ts - Add missing patterns
const MISSING_PATTERNS = [
  {
    regex: /user_weekly_rate_limited/i,
    type: 'rate_limit',
    label: 'Copilot weekly rate limit exceeded',
  },
  {
    regex: /rate\.limit\.exceeded/i,
    type: 'rate_limit',
    label: 'rate limit exceeded message',
  },
];
```

```typescript
// rateLimitChecker.ts - NEW MODULE (proposed)
interface GitHubRateLimitStatus {
  core: { limit: number; remaining: number; reset: number; used: number };
  codeSearch: { limit: number; remaining: number; reset: number; used: number };
  graphql: { limit: number; remaining: number; reset: number; used: number };
  search: { limit: number; remaining: number; reset: number; used: number };
}

async function checkGitHubRateLimit(): Promise<GitHubRateLimitStatus | null> {
  // Call GET /rate_limit
  // Returns parsed status or null on error
}

function shouldAttemptResurrection(status: GitHubRateLimitStatus, config: ResurrectConfig): boolean {
  // If core remaining < blockThreshold, return false
  // If reset time > maxWaitTime, return false
  // Otherwise return true
}

function getWaitTime(status: GitHubRateLimitStatus): number {
  // Return seconds until core resource resets
}
```

---

## 13. Open Questions / Next Steps

1. **Token scope** - What scopes does the VS Code Copilot extension token have? Can we use it for `GET /rate_limit`?
2. **Proactive vs Reactive** - Should we check rate limits BEFORE attempting resurrection, or only react to errors?
3. **Weekly limit differentiation** - The `user_weekly_rate_limited` is different from hourly limits. Should we have separate handling?
4. **Copilot Chat API headers** - Do Copilot Chat API responses include additional rate limit headers not visible in standard API calls?
5. **Implementation scope** - Should this be a new module (`rateLimitChecker.ts`) or integrated into existing modules?
6. **Metrics API applicability** - Confirmed that Copilot Usage Metrics API is NOT useful for session resurrection (requires org admin, returns reports not real-time data). Focus remains on `GET /rate_limit`.

---

*Document prepared for feature implementation planning. Updated with live API test results on April 16, 2026.*
