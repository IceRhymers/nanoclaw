import { readEnvFile } from './env.js';
import {
  ASSISTANT_NAME,
  GITHUB_PR_ALLOWED_USERS,
  GITHUB_PR_POLL_INTERVAL,
  GITHUB_PR_REPLY_JID,
  GITHUB_PR_REPOS,
  GITHUB_PR_TRIGGER,
} from './config.js';
import { isGitHubCommentProcessed, markGitHubCommentProcessed } from './db.js';
import { logger } from './logger.js';
import { NewMessage, RegisteredGroup } from './types.js';

const GITHUB_API = 'https://api.github.com';

// ETag cache: GitHub returns 304 Not Modified (doesn't count toward rate limit) when content unchanged
const etagCache = new Map<string, string>();

export interface PRWatcherDeps {
  storeMessage: (msg: NewMessage) => void;
  findMainGroupJid: () => string | undefined;
}

export interface GitHubComment {
  id: number;
  body: string;
  user: { login: string };
  created_at: string;
  html_url: string;
  // Present on issue comments for PRs
  issue_url?: string;
  // Present on review comments
  pull_request_url?: string;
  path?: string;
  line?: number | null;
  original_line?: number | null;
  diff_hunk?: string;
  pull_request_review_id?: number;
}

interface GitHubPR {
  number: number;
  title: string;
  body: string | null;
  user: { login: string };
  html_url: string;
  diff_url: string;
}

interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  state: string;
  user: { login: string };
  html_url: string;
  labels: Array<{ name: string }>;
  pull_request?: unknown; // present if this issue is actually a PR
}

function getGhToken(): string {
  return process.env.GH_TOKEN || readEnvFile(['GH_TOKEN']).GH_TOKEN || '';
}

async function ghFetch<T>(path: string, options?: RequestInit): Promise<T | null> {
  const token = getGhToken();
  if (!token) throw new Error('GH_TOKEN not configured');

  const etagHeaders: Record<string, string> = {};
  const cachedEtag = etagCache.get(path);
  if (cachedEtag && (!options || options.method === undefined || options.method === 'GET')) {
    etagHeaders['If-None-Match'] = cachedEtag;
  }

  const res = await fetch(`${GITHUB_API}${path}`, {
    ...options,
    headers: {
      Authorization: `token ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...etagHeaders,
      ...options?.headers,
    },
  });

  // 304 Not Modified — no new data, doesn't count toward rate limit
  if (res.status === 304) {
    return null;
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GitHub API ${res.status}: ${path} — ${body}`);
  }

  // Cache the ETag for next request
  const etag = res.headers.get('etag');
  if (etag) {
    etagCache.set(path, etag);
  }

  return res.json() as Promise<T>;
}

async function addReaction(
  repo: string,
  commentId: number,
  commentType: 'issue' | 'review',
): Promise<void> {
  const endpoint =
    commentType === 'review'
      ? `/repos/${repo}/pulls/comments/${commentId}/reactions`
      : `/repos/${repo}/issues/comments/${commentId}/reactions`;

  await ghFetch(endpoint, {
    method: 'POST',
    body: JSON.stringify({ content: 'eyes' }),
  });
}

function extractPrNumber(comment: GitHubComment): number | null {
  // Issue comments have issue_url like https://api.github.com/repos/owner/repo/issues/42
  if (comment.issue_url) {
    const match = comment.issue_url.match(/\/issues\/(\d+)$/);
    return match ? parseInt(match[1], 10) : null;
  }
  // Review comments have pull_request_url
  if (comment.pull_request_url) {
    const match = comment.pull_request_url.match(/\/pulls\/(\d+)$/);
    return match ? parseInt(match[1], 10) : null;
  }
  return null;
}

async function fetchIssueDetails(
  repo: string,
  issueNumber: number,
): Promise<GitHubIssue> {
  const result = await ghFetch<GitHubIssue>(`/repos/${repo}/issues/${issueNumber}`);
  if (!result) throw new Error(`No data for issue ${repo}#${issueNumber}`);
  return result;
}

async function fetchPRDetails(
  repo: string,
  prNumber: number,
): Promise<GitHubPR> {
  const result = await ghFetch<GitHubPR>(`/repos/${repo}/pulls/${prNumber}`);
  if (!result) throw new Error(`No data for PR ${repo}#${prNumber}`);
  return result;
}

async function fetchPRDiff(repo: string, prNumber: number): Promise<string> {
  const token = getGhToken();
  const res = await fetch(`${GITHUB_API}/repos/${repo}/pulls/${prNumber}`, {
    headers: {
      Authorization: `token ${token}`,
      Accept: 'application/vnd.github.diff',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!res.ok) return '[diff unavailable]';
  const diff = await res.text();
  // Truncate large diffs to avoid overwhelming the agent
  const MAX_DIFF = 8000;
  return diff.length > MAX_DIFF
    ? diff.slice(0, MAX_DIFF) + '\n... [diff truncated]'
    : diff;
}

function buildPrompt(
  repo: string,
  pr: GitHubPR,
  comment: GitHubComment,
  diff: string,
  commentType: 'issue' | 'review',
): string {
  const triggerStripped = comment.body
    .replace(
      new RegExp(
        GITHUB_PR_TRIGGER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
        'gi',
      ),
      '',
    )
    .trim();

  const lines: string[] = [
    `@${ASSISTANT_NAME} GitHub PR Comment`,
    '',
    `Repository: ${repo}`,
    `PR #${pr.number}: "${pr.title}" by ${pr.user.login}`,
    `Comment by: ${comment.user.login}`,
    `Link: ${comment.html_url}`,
  ];

  if (commentType === 'review' && comment.path) {
    lines.push(
      `File: ${comment.path}${comment.line ? ` (line ${comment.line})` : ''}`,
    );
    if (comment.diff_hunk) {
      lines.push('', 'Diff hunk:', '```diff', comment.diff_hunk, '```');
    }
  }

  lines.push('', 'Comment:', `> ${triggerStripped || comment.body}`, '');

  if (commentType === 'issue') {
    lines.push('Full PR diff:', '```diff', diff, '```', '');
  }

  lines.push(
    'Respond with your analysis. You have access to the `gh` CLI to interact with the PR.',
    `If you want to reply on the PR itself, use: gh pr comment ${pr.number} --repo ${repo} --body "your reply"`,
    'IMPORTANT: Always end your PR comment with a sign-off on its own line: 🦀 *(reply via claw)*',
  );

  return lines.join('\n');
}

function buildIssuePrompt(
  repo: string,
  issue: GitHubIssue,
  comment: GitHubComment,
): string {
  const triggerStripped = comment.body
    .replace(
      new RegExp(
        GITHUB_PR_TRIGGER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
        'gi',
      ),
      '',
    )
    .trim();

  const labels = issue.labels.map((l) => l.name).join(', ');

  const lines: string[] = [
    `@${ASSISTANT_NAME} GitHub Issue`,
    '',
    `Repository: ${repo}`,
    `Issue #${issue.number}: "${issue.title}" by ${issue.user.login}`,
    `Link: ${issue.html_url}`,
  ];

  if (labels) {
    lines.push(`Labels: ${labels}`);
  }

  if (issue.body) {
    lines.push('', 'Issue description:', issue.body);
  }

  lines.push(
    '',
    `Comment by: ${comment.user.login}`,
    `> ${triggerStripped || comment.body}`,
    '',
    'You have access to the `gh` CLI to interact with this issue.',
    `To comment on the issue: gh issue comment ${issue.number} --repo ${repo} --body "your reply"`,
    'IMPORTANT: Always end your issue comment with a sign-off on its own line: 🦀 *(reply via claw)*',
  );

  return lines.join('\n');
}

export async function processComment(
  repo: string,
  comment: GitHubComment,
  commentType: 'issue' | 'review',
  deps: PRWatcherDeps,
): Promise<void> {
  const commentIdStr = `${commentType}-${comment.id}`;

  if (isGitHubCommentProcessed(commentIdStr)) return;

  const itemNumber = extractPrNumber(comment);
  if (!itemNumber) {
    logger.warn(
      { commentId: comment.id, repo },
      'Could not extract issue/PR number from comment',
    );
    return;
  }

  const targetJid = GITHUB_PR_REPLY_JID || deps.findMainGroupJid();
  if (!targetJid) {
    logger.warn('GitHub PR watcher: no reply target configured, skipping');
    return;
  }

  // Check if this is a PR or a plain issue
  const issue = await fetchIssueDetails(repo, itemNumber);

  if (!issue.pull_request) {
    // Plain issue — skip if closed
    if (issue.state !== 'open') {
      logger.info(
        { repo, issue: itemNumber, state: issue.state },
        'Skipping closed issue comment',
      );
      return;
    }

    logger.info(
      { repo, issue: itemNumber, commentId: comment.id, author: comment.user.login },
      'Processing GitHub issue comment',
    );

    try {
      await addReaction(repo, comment.id, 'issue');
    } catch (err) {
      logger.warn({ err, commentId: comment.id }, 'Failed to add reaction');
    }

    const prompt = buildIssuePrompt(repo, issue, comment);

    deps.storeMessage({
      id: `gh-${commentIdStr}`,
      chat_jid: targetJid,
      sender: 'github',
      sender_name: 'GitHub Issue',
      content: prompt,
      timestamp: new Date().toISOString(),
      is_from_me: true,
    });

    markGitHubCommentProcessed(commentIdStr, 'issue', repo, itemNumber);
    return;
  }

  // It's a PR — existing flow
  logger.info(
    { repo, pr: itemNumber, commentId: comment.id, author: comment.user.login },
    'Processing GitHub PR comment',
  );

  try {
    await addReaction(repo, comment.id, commentType);
  } catch (err) {
    logger.warn({ err, commentId: comment.id }, 'Failed to add reaction');
  }

  const [pr, diff] = await Promise.all([
    fetchPRDetails(repo, itemNumber),
    commentType === 'issue' ? fetchPRDiff(repo, itemNumber) : Promise.resolve(''),
  ]);

  const prompt = buildPrompt(repo, pr, comment, diff, commentType);

  deps.storeMessage({
    id: `gh-${commentIdStr}`,
    chat_jid: targetJid,
    sender: 'github',
    sender_name: 'GitHub PR',
    content: prompt,
    timestamp: new Date().toISOString(),
    is_from_me: true,
  });

  markGitHubCommentProcessed(commentIdStr, commentType, repo, itemNumber);
}

export function matchesTrigger(body: string): boolean {
  return new RegExp(
    GITHUB_PR_TRIGGER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    'i',
  ).test(body);
}

export function isAllowedUser(login: string): boolean {
  return GITHUB_PR_ALLOWED_USERS.includes(login.toLowerCase());
}

async function pollRepo(
  repo: string,
  since: string,
  deps: PRWatcherDeps,
): Promise<void> {
  // Fetch issue comments (general PR/issue comments)
  try {
    const issueComments = await ghFetch<GitHubComment[]>(
      `/repos/${repo}/issues/comments?since=${since}&sort=created&direction=asc&per_page=100`,
    );
    if (issueComments) {
      for (const comment of issueComments) {
        if (!comment.issue_url) continue;
        if (!matchesTrigger(comment.body)) continue;
        if (!isAllowedUser(comment.user.login)) continue;
        await processComment(repo, comment, 'issue', deps);
      }
    }
  } catch (err) {
    logger.error({ err, repo }, 'Failed to fetch issue comments');
  }

  // Fetch review comments (inline code comments)
  try {
    const reviewComments = await ghFetch<GitHubComment[]>(
      `/repos/${repo}/pulls/comments?since=${since}&sort=created&direction=asc&per_page=100`,
    );
    if (reviewComments) {
      for (const comment of reviewComments) {
        if (!matchesTrigger(comment.body)) continue;
        if (!isAllowedUser(comment.user.login)) continue;
        await processComment(repo, comment, 'review', deps);
      }
    }
  } catch (err) {
    logger.error({ err, repo }, 'Failed to fetch review comments');
  }
}

export function startGitHubPRWatcher(deps: PRWatcherDeps): void {
  if (GITHUB_PR_REPOS.length === 0) {
    logger.warn('GitHub PR watcher enabled but GITHUB_PR_REPOS is empty');
    return;
  }
  if (GITHUB_PR_ALLOWED_USERS.length === 0) {
    logger.warn(
      'GitHub PR watcher enabled but GITHUB_PR_ALLOWED_USERS is empty',
    );
    return;
  }
  if (!getGhToken()) {
    logger.warn('GitHub PR watcher enabled but GH_TOKEN is not set');
    return;
  }

  logger.info(
    {
      repos: GITHUB_PR_REPOS,
      users: GITHUB_PR_ALLOWED_USERS,
      trigger: GITHUB_PR_TRIGGER,
    },
    'Starting GitHub PR comment watcher',
  );

  // Start polling from now (don't backfill old comments)
  let lastPoll = new Date().toISOString();

  const poll = async () => {
    const since = lastPoll;
    lastPoll = new Date().toISOString();

    for (const repo of GITHUB_PR_REPOS) {
      await pollRepo(repo, since, deps);
    }
  };

  // Initial poll after a short delay (let main group register first)
  setTimeout(() => {
    poll().catch((err) =>
      logger.error({ err }, 'GitHub PR watcher poll error'),
    );
  }, 5000);

  setInterval(() => {
    poll().catch((err) =>
      logger.error({ err }, 'GitHub PR watcher poll error'),
    );
  }, GITHUB_PR_POLL_INTERVAL);
}
