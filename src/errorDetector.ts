/**
 * ErrorDetector — content-based detection of Copilot Chat error states.
 *
 * Unlike silence detection (which watches for inactivity), this module reads
 * the actual content of Copilot Chat session files to detect error messages
 * that indicate the session is dead even though the filesystem shows activity
 * (because the error text itself is written as chat content).
 *
 * Key error patterns:
 *  - Rate limiting: "rate_limited", "you have been rate-limited", "exhausted this model's rate limit"
 *  - Server errors: "Server Error", "malformed", "internal server error"
 *  - Content filtering: "response was filtered"
 *  - Model availability: "Please try a different model"
 */
import * as fs from 'fs';
import { Logger } from './logger';

export type ErrorType = 'rate_limit' | 'server_error' | 'content_filtered' | 'unknown_error';

export type RateLimitSeverity = 'critical' | 'high' | 'medium' | 'low';

export interface RateLimitHeaders {
  retryAfterSeconds: number | null;
  limit: number | null;
  remaining: number | null;
  resetEpochSeconds: number | null;
  resource: string | null;
  requestId: string | null;
}

export interface RateLimitInfo {
  code: string | null;
  message: string | null;
  severity: RateLimitSeverity;
  scope: 'shadow' | 'github_api' | 'unknown';
  retryAfterSeconds: number | null;
  cooldownSeconds: number;
  headers: RateLimitHeaders;
  matchedBy: string;
}

export interface DetectedError {
  type: ErrorType;
  pattern: string;
  filePath: string;
  timestamp: Date;
  details?: RateLimitInfo;
  excerpt?: string;
}

/**
 * Patterns to search for in the tail of session files.
 * Each entry maps a regex pattern to an error type.
 * Patterns are case-insensitive and tested against the last chunk of file content.
 */
const ERROR_PATTERNS: Array<{ regex: RegExp; type: ErrorType; label: string }> = [
  // Server errors
  {
    regex: /Server Error:/i,
    type: 'server_error',
    label: 'server error prefix',
  },
  {
    regex: /internal server error/i,
    type: 'server_error',
    label: 'internal server error',
  },
  {
    regex: /malformed.{0,20}(request|response|prompt)/i,
    type: 'server_error',
    label: 'malformed request/response',
  },
  // Content filtering
  {
    regex: /the response was filtered/i,
    type: 'content_filtered',
    label: 'response filtered',
  },
  {
    regex: /content management policy/i,
    type: 'content_filtered',
    label: 'content policy violation',
  },
];

const SHADOW_RATE_LIMIT_PATTERNS: Array<{
  regex: RegExp;
  label: string;
  code?: string;
  severity: RateLimitSeverity;
  cooldownSeconds: number;
  scope?: 'shadow' | 'github_api' | 'unknown';
}> = [
  {
    regex: /user_weekly_rate_limited/i,
    label: 'weekly rate limit exceeded',
    code: 'user_weekly_rate_limited',
    severity: 'critical',
    cooldownSeconds: 7 * 24 * 60 * 60,
    scope: 'shadow',
  },
  {
    regex: /user_daily_rate_limited/i,
    label: 'daily rate limit exceeded',
    code: 'user_daily_rate_limited',
    severity: 'high',
    cooldownSeconds: 24 * 60 * 60,
    scope: 'shadow',
  },
  {
    regex: /user_hourly_rate_limited/i,
    label: 'hourly rate limit exceeded',
    code: 'user_hourly_rate_limited',
    severity: 'medium',
    cooldownSeconds: 60 * 60,
    scope: 'shadow',
  },
  {
    regex: /user_global_rate_limited(?::[a-z0-9_-]+)?/i,
    label: 'global rate limit exceeded',
    severity: 'high',
    cooldownSeconds: 10 * 60,
    scope: 'shadow',
  },
  {
    regex: /model_capacity_limited/i,
    label: 'model capacity exceeded',
    code: 'model_capacity_limited',
    severity: 'high',
    cooldownSeconds: 30 * 60,
    scope: 'shadow',
  },
  {
    regex: /model_rate_limited/i,
    label: 'model rate limit exceeded',
    code: 'model_rate_limited',
    severity: 'high',
    cooldownSeconds: 15 * 60,
    scope: 'shadow',
  },
  {
    regex: /quota_exceeded/i,
    label: 'quota exceeded',
    code: 'quota_exceeded',
    severity: 'medium',
    cooldownSeconds: 5 * 60,
    scope: 'shadow',
  },
  {
    regex: /too_many_requests/i,
    label: 'too many requests',
    code: 'too_many_requests',
    severity: 'low',
    cooldownSeconds: 60,
    scope: 'shadow',
  },
  {
    regex: /user_rate_limited/i,
    label: 'user rate limited',
    code: 'user_rate_limited',
    severity: 'medium',
    cooldownSeconds: 5 * 60,
    scope: 'shadow',
  },
  {
    regex: /you have been rate[- ]limited/i,
    label: 'rate-limited message',
    severity: 'medium',
    cooldownSeconds: 5 * 60,
    scope: 'unknown',
  },
  {
    regex: /exhausted this model'?s rate limit/i,
    label: 'model rate limit exhausted',
    severity: 'high',
    cooldownSeconds: 15 * 60,
    scope: 'shadow',
  },
  {
    regex: /error[_ ]code:\s*rate[_ ]limited/i,
    label: 'rate_limited error code',
    code: 'rate_limited',
    severity: 'medium',
    cooldownSeconds: 5 * 60,
    scope: 'unknown',
  },
  {
    regex: /Please try a different model/i,
    label: 'try different model suggestion',
    severity: 'high',
    cooldownSeconds: 15 * 60,
    scope: 'shadow',
  },
  {
    regex: /429\b/i,
    label: 'http 429 detected',
    severity: 'low',
    cooldownSeconds: 60,
    scope: 'unknown',
  },
  // Copilot Chat internal log format: "ccreq:xxx | rateLimited | gpt-4o-mini | 265ms"
  {
    regex: /\|\s*rateLimited\s*\|/i,
    label: 'copilot-internal rate limit signal',
    severity: 'high',
    cooldownSeconds: 5 * 60,
    scope: 'shadow',
  },
];

/** How many bytes from the end of the file to read for error scanning. */
const TAIL_BYTES = 4096;

/**
 * Tracks last-seen file sizes to avoid re-scanning unchanged content.
 * Key = absolute file path, value = last scanned file size.
 */
const _lastScannedSize = new Map<string, number>();

function parseHeaderInt(content: string, headerName: string): number | null {
  const match = content.match(new RegExp(`${headerName}:\\s*(\\d+)`, 'i'));
  if (!match) {
    return null;
  }

  const parsed = parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseHeaderString(content: string, headerName: string): string | null {
  const match = content.match(new RegExp(`${headerName}:\\s*([^\\r\\n]+)`, 'i'));
  return match?.[1]?.trim() || null;
}

function extractJsonLikeField(content: string, fieldName: string): string | null {
  const escapedField = fieldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // Match top-level "field": "value" (quoted string value)
  const quoted = content.match(new RegExp(`"${escapedField}"\\s*:\\s*"([^"]+)"`, 'i'));
  if (quoted?.[1]) {
    return quoted[1];
  }

  // Match top-level 'field': 'value' (single-quoted)
  const singleQuoted = content.match(new RegExp(`"${escapedField}"\\s*:\\s*'([^']+)'`, 'i'));
  if (singleQuoted?.[1]) {
    return singleQuoted[1];
  }

  // Match top-level 'field': value (unquoted — e.g., "code": user_rate_limited)
  const plain = content.match(new RegExp(`"${escapedField}"\\s*:\\s*([A-Za-z0-9_:-]+)`, 'i'));
  if (plain?.[1]) {
    return plain[1];
  }

  // Match nested { "parent": { "field": "value" } } pattern
  // e.g., { "error": { "code": "user_weekly_rate_limited" } }
  const nested = content.match(
    new RegExp(`"${escapedField}"\\s*:\\s*\{[^}]*"${escapedField}"\\s*:\\s*"([^"]+)"`, 'i')
  );
  if (nested?.[1]) {
    return nested[1];
  }

  return null;
}

function extractExcerpt(content: string, needle: string): string | undefined {
  const idx = content.toLowerCase().indexOf(needle.toLowerCase());
  if (idx < 0) {
    return undefined;
  }

  const start = Math.max(0, idx - 100);
  const end = Math.min(content.length, idx + needle.length + 140);
  return content.slice(start, end).replace(/\s+/g, ' ').trim();
}

function detectRateLimitInfo(content: string): RateLimitInfo | null {
  const parsedCode = extractJsonLikeField(content, 'code');
  const parsedMessage = extractJsonLikeField(content, 'message');
  const headers: RateLimitHeaders = {
    retryAfterSeconds: parseHeaderInt(content, 'Retry-After'),
    limit: parseHeaderInt(content, 'X-RateLimit-Limit'),
    remaining: parseHeaderInt(content, 'X-RateLimit-Remaining'),
    resetEpochSeconds: parseHeaderInt(content, 'X-RateLimit-Reset'),
    resource: parseHeaderString(content, 'X-RateLimit-Resource'),
    requestId: parseHeaderString(content, 'X-GitHub-Request-Id'),
  };

  for (const candidate of SHADOW_RATE_LIMIT_PATTERNS) {
    const match = content.match(candidate.regex);
    if (!match) {
      continue;
    }

    const code = parsedCode || candidate.code || match[0];
    const retryAfterSeconds = headers.retryAfterSeconds;
    const cooldownSeconds = Math.max(candidate.cooldownSeconds, retryAfterSeconds ?? 0);
    const scope = candidate.scope ?? (headers.resource ? 'github_api' : 'unknown');

    return {
      code,
      message: parsedMessage,
      severity: candidate.severity,
      scope,
      retryAfterSeconds,
      cooldownSeconds,
      headers,
      matchedBy: candidate.label,
    };
  }

  return null;
}

/**
 * Check a session file for error patterns.
 * Only reads the tail of the file (last TAIL_BYTES) for efficiency.
 * Returns the first matching error, or null if no error patterns found.
 *
 * Skips the scan if the file hasn't grown since the last check (the error
 * message would be in the new content appended to the file).
 */
export function checkFileForErrors(filePath: string): DetectedError | null {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size === 0) {
      return null;
    }

    // Skip if file hasn't changed size since last scan
    const prevSize = _lastScannedSize.get(filePath) ?? 0;
    if (stat.size <= prevSize) {
      return null;
    }
    _lastScannedSize.set(filePath, stat.size);

    // Read the tail of the file
    const readStart = Math.max(0, stat.size - TAIL_BYTES);
    const readLength = Math.min(stat.size, TAIL_BYTES);
    const buffer = new Uint8Array(readLength);
    const fd = fs.openSync(filePath, 'r');
    try {
      fs.readSync(fd, buffer, 0, readLength, readStart);
    } finally {
      fs.closeSync(fd);
    }

    const content = new TextDecoder('utf-8').decode(buffer);

    const rateLimitInfo = detectRateLimitInfo(content);
    if (rateLimitInfo) {
      Logger.warn(
        `Error detected in session file: ${rateLimitInfo.matchedBy} ` +
        `(type: rate_limit${rateLimitInfo.code ? `, code: ${rateLimitInfo.code}` : ''})`
      );
      Logger.debug(`  File: ${filePath}`);
      return {
        type: 'rate_limit',
        pattern: rateLimitInfo.matchedBy,
        filePath,
        timestamp: new Date(),
        details: rateLimitInfo,
        excerpt: extractExcerpt(content, rateLimitInfo.code || rateLimitInfo.matchedBy),
      };
    }

    // Test each pattern against the tail content
    for (const { regex, type, label } of ERROR_PATTERNS) {
      if (regex.test(content)) {
        Logger.warn(`Error detected in session file: ${label} (type: ${type})`);
        Logger.debug(`  File: ${filePath}`);
        return {
          type,
          pattern: label,
          filePath,
          timestamp: new Date(),
          excerpt: extractExcerpt(content, label),
        };
      }
    }

    return null;
  } catch (err) {
    // File may be locked by Copilot Chat — log and skip silently
    Logger.debug(`Could not scan session file: ${filePath} (${err})`);
    return null;
  }
}

/**
 * Scan all .json files in a directory for error patterns.
 * Returns the first match found, or null.
 */
export function scanDirectoryForErrors(dirPath: string): DetectedError | null {
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.json')) {
        const fullPath = `${dirPath}/${entry.name}`;
        const result = checkFileForErrors(fullPath);
        if (result) {
          return result;
        }
      }
    }
  } catch {
    // Directory may not exist yet — that's fine
  }
  return null;
}

/**
 * Reset the size tracking cache. Call this after a successful resurrection
 * so the next file write (the new session) gets a fresh baseline.
 */
export function resetScanCache(): void {
  _lastScannedSize.clear();
}
