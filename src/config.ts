import * as vscode from 'vscode';

export const EXT_ID = 'copilot-resurrect';
export const SILENCE_TIMEOUT_MIN_SECONDS = 60;
export const SILENCE_TIMEOUT_MAX_SECONDS = 1200;

export type ApprovalsMode = 'default' | 'bypass' | 'autopilot';
export type PromptCompactionStrategy = 'normalize-whitespace' | 'compact-structure' | 'directive-template';

export const PROMPT_COMPACTION_STRATEGIES: PromptCompactionStrategy[] = [
  'normalize-whitespace',
  'compact-structure',
  'directive-template',
];

function getWorkspaceSetting<T>(cfg: vscode.WorkspaceConfiguration, key: string, defaultValue: T): T {
  const inspected = cfg.inspect<T>(key);
  if (!inspected) {
    return defaultValue;
  }

  if (inspected.workspaceFolderValue !== undefined) {
    return inspected.workspaceFolderValue as T;
  }

  if (inspected.workspaceValue !== undefined) {
    return inspected.workspaceValue as T;
  }

  return defaultValue;
}

export function hasWorkspaceConfigurationTarget(): boolean {
  return Boolean(vscode.workspace.workspaceFile || vscode.workspace.workspaceFolders?.length);
}

export async function updateWorkspaceSetting<T>(key: string, value: T): Promise<boolean> {
  if (!hasWorkspaceConfigurationTarget()) {
    vscode.window.showWarningMessage(
      'Copilot Resurrect settings are workspace-only. Open a folder or workspace before changing settings.'
    );
    return false;
  }

  await vscode.workspace
    .getConfiguration(EXT_ID)
    .update(key, value, vscode.ConfigurationTarget.Workspace);
  return true;
}

export interface ResurrectConfig {
  enabled: boolean;
  ignitionPrompt: string;
  silenceTimeoutSeconds: number;
  maxRestartsPerDay: number;
  preferredModel: string;
  fallbackModel: string;
  fallbackModelChain: string[];
  chatParticipant: string;
  agentMode: string;
  approvalsMode: ApprovalsMode;
  rateLimitCooldownBaseSeconds: number;
  rateLimitCooldownMaxSeconds: number;
  startNewSession: boolean;
  preferNewSessionOnRateLimit: boolean;
  promptCompactionEnabled: boolean;
  promptCompactionStrategy: PromptCompactionStrategy;
  contentCheckEnabled: boolean;
  watchPaths: string[];
  watchIgnorePatterns: string[];
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function compactModelChain(models: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const raw of models) {
    const model = raw.trim();
    if (!model) {
      continue;
    }

    const key = model.toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(model);
  }

  return result;
}

/**
 * Normalize an error code string for consistent comparison.
 * Handles colon-vs-underscore variants (e.g., "error_code: rate_limited" → "rate_limited").
 */
export function normalizeErrorCode(code: string | null | undefined): string | null {
  if (!code) {
    return null;
  }
  return code
    .toLowerCase()
    .replace(/^error[_ ]code[:\s]*/i, '')   // strip "error_code:" or "error code:" prefix
    .replace(/[:\s]/g, '_')                  // colons/spaces → underscores
    .replace(/^_+|_+$/g, '')                 // trim leading/trailing underscores
    .trim();
}

export function getConfig(): ResurrectConfig {
  const cfg = vscode.workspace.getConfiguration(EXT_ID);
  const silenceTimeoutSeconds = clampNumber(
    getWorkspaceSetting(cfg, 'silenceTimeoutSeconds', 180),
    SILENCE_TIMEOUT_MIN_SECONDS,
    SILENCE_TIMEOUT_MAX_SECONDS,
  );
  const fallbackModel = getWorkspaceSetting(cfg, 'fallbackModel', '').trim();
  const fallbackModelChain = compactModelChain([
    ...getWorkspaceSetting<string[]>(cfg, 'fallbackModelChain', []),
    fallbackModel,
  ]);
  const promptCompactionStrategyRaw = getWorkspaceSetting(cfg, 'promptCompactionStrategy', 'normalize-whitespace');
  const promptCompactionStrategy = PROMPT_COMPACTION_STRATEGIES.includes(promptCompactionStrategyRaw as PromptCompactionStrategy)
    ? promptCompactionStrategyRaw as PromptCompactionStrategy
    : 'normalize-whitespace';

  return {
    enabled: getWorkspaceSetting(cfg, 'enabled', false),
    ignitionPrompt: getWorkspaceSetting(cfg, 'ignitionPrompt', ''),
    silenceTimeoutSeconds,
    maxRestartsPerDay: getWorkspaceSetting(cfg, 'maxRestartsPerDay', 50),
    preferredModel: getWorkspaceSetting(cfg, 'preferredModel', ''),
    fallbackModel,
    fallbackModelChain,
    chatParticipant: getWorkspaceSetting(cfg, 'chatParticipant', ''),
    agentMode: getWorkspaceSetting(cfg, 'agentMode', ''),
    approvalsMode: getWorkspaceSetting(cfg, 'approvalsMode', 'default'),
    rateLimitCooldownBaseSeconds: getWorkspaceSetting(cfg, 'rateLimitCooldownBaseSeconds', 30),
    rateLimitCooldownMaxSeconds: getWorkspaceSetting(cfg, 'rateLimitCooldownMaxSeconds', 600),
    startNewSession: getWorkspaceSetting(cfg, 'startNewSession', true),
    preferNewSessionOnRateLimit: getWorkspaceSetting(cfg, 'preferNewSessionOnRateLimit', true),
    promptCompactionEnabled: getWorkspaceSetting(cfg, 'promptCompactionEnabled', false),
    promptCompactionStrategy,
    contentCheckEnabled: getWorkspaceSetting(cfg, 'contentCheckEnabled', true),
    watchPaths: getWorkspaceSetting<string[]>(cfg, 'watchPaths', []),
    watchIgnorePatterns: getWorkspaceSetting<string[]>(cfg, 'watchIgnorePatterns', ['**/.git/**', '.git/**']),
  };
}

export async function setEnabled(value: boolean): Promise<boolean> {
  return await updateWorkspaceSetting('enabled', value);
}

/**
 * Build the full ignition prompt from config.
 * Prepends @participant prefix if configured.
 */
export function buildFullPrompt(cfg: ResurrectConfig, promptOverride?: string): string {
  const prompt = (promptOverride ?? cfg.ignitionPrompt).trim();
  if (!prompt) {
    return '';
  }
  const participant = cfg.chatParticipant.trim();
  if (participant) {
    const prefix = participant.startsWith('@') ? participant : `@${participant}`;
    return `${prefix} ${prompt}`;
  }
  return prompt;
}

export function getEffectiveFallbackModelChain(cfg: ResurrectConfig): string[] {
  return compactModelChain(cfg.fallbackModelChain);
}

/**
 * Discover available Copilot Chat models via the VS Code Language Model API.
 * Returns an array of model info objects with id, name, family, and vendor.
 *
 * Usage: Populate `fallbackModelChain` settings or let users pick from real models.
 */
export async function discoverAvailableModels(): Promise<
  Array<{ id: string; name: string; family: string; vendor: string }>
> {
  try {
    const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
    return models.map(m => ({
      id: m.id,
      name: m.name,
      family: m.family,
      vendor: m.vendor,
    }));
  } catch {
    // LM API not available or no models — return empty
    return [];
  }
}

export function compactIgnitionPrompt(
  prompt: string,
  strategy: PromptCompactionStrategy,
): string {
  const trimmed = prompt.trim();
  if (!trimmed) {
    return '';
  }

  switch (strategy) {
    case 'normalize-whitespace':
      return trimmed
        .replace(/\r\n/g, '\n')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    case 'compact-structure':
      return trimmed
        .split('\n')
        .map(line => line.trimEnd())
        .filter((line, index, all) => !(line === '' && all[index - 1] === ''))
        .join('\n')
        .trim();
    case 'directive-template':
      return `Resume the user's autonomous workflow safely and continue from the current repository state. ${trimmed.replace(/\s+/g, ' ').trim()}`;
    default:
      return trimmed;
  }
}

/**
 * Enumerate available language models from the Copilot vendor.
 * Returns model descriptors sorted by family name.
 */
export async function getAvailableModels(): Promise<vscode.LanguageModelChat[]> {
  try {
    const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
    return models.sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

export interface AgentModeInfo {
  name: string;
  description: string;
  source: 'workspace' | 'builtin';
}

/** Built-in Copilot Chat modes. */
const BUILTIN_MODES: AgentModeInfo[] = [
  { name: 'agent', description: 'Agent mode — full tool access (default)', source: 'builtin' },
  { name: 'edit', description: 'Edit mode — can edit files, no terminal', source: 'builtin' },
  { name: 'ask', description: 'Ask mode — read-only, no tools', source: 'builtin' },
];

/**
 * Discover available agent modes by scanning workspace `.github/agents/*.agent.md`
 * files and parsing their YAML frontmatter `description` field.
 * Returns built-in modes + discovered custom agents.
 */
export async function discoverAgentModes(): Promise<AgentModeInfo[]> {
  const results: AgentModeInfo[] = [...BUILTIN_MODES];

  const folders = vscode.workspace.workspaceFolders;
  if (!folders) {
    return results;
  }

  for (const folder of folders) {
    const agentsDir = vscode.Uri.joinPath(folder.uri, '.github', 'agents');
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(agentsDir);
    } catch {
      continue; // No .github/agents/ in this folder
    }

    for (const [fileName, fileType] of entries) {
      if (fileType !== vscode.FileType.File || !fileName.endsWith('.agent.md')) {
        continue;
      }
      const modeName = fileName.replace('.agent.md', '');

      // Parse description from YAML frontmatter
      let description = '';
      try {
        const fileUri = vscode.Uri.joinPath(agentsDir, fileName);
        const raw = await vscode.workspace.fs.readFile(fileUri);
        const text = new TextDecoder('utf-8').decode(raw);
        const fmMatch = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
        if (fmMatch) {
          const descMatch = fmMatch[1].match(/description:\s*['"]?(.*?)['"]?\s*$/m);
          if (descMatch) {
            description = descMatch[1];
          }
        }
      } catch {
        // Skip files that can't be read
      }

      results.push({
        name: modeName,
        description: description || `Custom agent: ${modeName}`,
        source: 'workspace',
      });
    }
  }

  return results;
}
