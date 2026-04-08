import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';

// Read config values from .env (falls back to process.env).
// Secrets (API keys, tokens) are NOT read here — they are loaded only
// by the credential proxy (credential-proxy.ts), never exposed to containers.
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'TELEGRAM_BOT_POOL',
  'GITHUB_PR_WATCHER',
  'GITHUB_PR_REPOS',
  'GITHUB_PR_ALLOWED_USERS',
  'GITHUB_PR_POLL_INTERVAL',
  'GITHUB_PR_TRIGGER',
  'GITHUB_PR_REPLY_JID',
]);

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER ||
    envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'mount-allowlist.json',
);
export const SENDER_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'sender-allowlist.json',
);
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');

export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'nanoclaw-agent:latest';
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '1800000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const CREDENTIAL_PROXY_PORT = parseInt(
  process.env.CREDENTIAL_PROXY_PORT || '3001',
  10,
);
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min default — how long to keep container alive after last result
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const TRIGGER_PATTERN = new RegExp(
  `^@${escapeRegex(ASSISTANT_NAME)}\\b`,
  'i',
);

// Bot pool for Telegram agent swarms: comma-separated tokens
export const TELEGRAM_BOT_POOL = (
  process.env.TELEGRAM_BOT_POOL ||
  envConfig.TELEGRAM_BOT_POOL ||
  ''
)
  .split(',')
  .map((t) => t.trim())
  .filter(Boolean);

// GitHub PR comment watcher
export const GITHUB_PR_WATCHER =
  (process.env.GITHUB_PR_WATCHER || envConfig.GITHUB_PR_WATCHER) === 'true';
export const GITHUB_PR_REPOS = (
  process.env.GITHUB_PR_REPOS ||
  envConfig.GITHUB_PR_REPOS ||
  ''
)
  .split(',')
  .map((r) => r.trim())
  .filter(Boolean);
export const GITHUB_PR_ALLOWED_USERS = (
  process.env.GITHUB_PR_ALLOWED_USERS ||
  envConfig.GITHUB_PR_ALLOWED_USERS ||
  ''
)
  .split(',')
  .map((u) => u.trim().toLowerCase())
  .filter(Boolean);
export const GITHUB_PR_POLL_INTERVAL = parseInt(
  process.env.GITHUB_PR_POLL_INTERVAL ||
    envConfig.GITHUB_PR_POLL_INTERVAL ||
    '30000',
  10,
);
export const GITHUB_PR_TRIGGER =
  process.env.GITHUB_PR_TRIGGER || envConfig.GITHUB_PR_TRIGGER || '#claw';
export const GITHUB_PR_REPLY_JID =
  process.env.GITHUB_PR_REPLY_JID || envConfig.GITHUB_PR_REPLY_JID || '';

// Timezone for scheduled tasks (cron expressions, etc.)
// Uses system timezone by default
export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
