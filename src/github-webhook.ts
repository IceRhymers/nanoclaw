/**
 * GitHub webhook server + smee.io relay.
 * Receives webhook events via smee SSE proxy and processes them
 * through the same pipeline as the polling watcher.
 */
import { createServer, IncomingMessage, ServerResponse, Server } from 'http';
import { createHmac, timingSafeEqual } from 'crypto';
import SmeeClient from 'smee-client';

import {
  GITHUB_PR_ALLOWED_USERS,
  GITHUB_SMEE_URL,
  GITHUB_WEBHOOK_PORT,
  GITHUB_WEBHOOK_SECRET,
} from './config.js';
import {
  GitHubComment,
  isAllowedUser,
  matchesTrigger,
  processComment,
  PRWatcherDeps,
} from './github-pr-watcher.js';
import { logger } from './logger.js';

interface WebhookPayload {
  action: string;
  comment: {
    id: number;
    body: string;
    user: { login: string };
    created_at: string;
    html_url: string;
    issue_url?: string;
    pull_request_url?: string;
    path?: string;
    line?: number | null;
    original_line?: number | null;
    diff_hunk?: string;
    pull_request_review_id?: number;
  };
  issue?: {
    number: number;
    pull_request?: unknown;
    state: string;
  };
  repository: {
    full_name: string;
  };
}

function verifySignature(
  payload: string,
  signature: string | undefined,
  secret: string,
): boolean {
  if (!secret) return true; // no secret configured, skip verification
  if (!signature) return false;

  const expected = `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`;
  try {
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

function handleWebhook(
  req: IncomingMessage,
  res: ServerResponse,
  deps: PRWatcherDeps,
): void {
  if (req.method !== 'POST' || req.url !== '/webhook') {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString();

    // Verify webhook signature
    // Note: smee.io re-serializes JSON, which can break HMAC verification.
    // Since the server binds to 127.0.0.1 only, the smee channel URL acts as the security gate.
    const signature = req.headers['x-hub-signature-256'] as string | undefined;
    if (GITHUB_WEBHOOK_SECRET && signature) {
      if (!verifySignature(body, signature, GITHUB_WEBHOOK_SECRET)) {
        logger.debug(
          'GitHub webhook: signature mismatch (smee may have re-serialized body)',
        );
      }
    }

    const event = req.headers['x-github-event'] as string;
    logger.info(
      { event, action: body.slice(0, 200), url: req.url, method: req.method },
      'GitHub webhook: received event',
    );
    if (event !== 'issue_comment' && event !== 'pull_request_review_comment') {
      // Ignore events we don't care about (ping, push, etc.)
      res.writeHead(200);
      res.end('OK');
      return;
    }

    let payload: WebhookPayload;
    try {
      const parsed = JSON.parse(body);
      // smee.io wraps the GitHub payload in a {"payload": "..."} envelope
      payload = parsed.payload ? JSON.parse(parsed.payload) : parsed;
    } catch {
      res.writeHead(400);
      res.end('Invalid JSON');
      return;
    }

    // Only process new comments
    if (payload.action !== 'created') {
      res.writeHead(200);
      res.end('OK');
      return;
    }

    const comment = payload.comment as GitHubComment;
    const repo = payload.repository.full_name;

    if (!matchesTrigger(comment.body)) {
      res.writeHead(200);
      res.end('OK');
      return;
    }

    if (!isAllowedUser(comment.user.login)) {
      res.writeHead(200);
      res.end('OK');
      return;
    }

    const commentType =
      event === 'pull_request_review_comment' ? 'review' : 'issue';

    logger.info(
      { repo, commentId: comment.id, event, author: comment.user.login },
      'GitHub webhook: processing comment',
    );

    // Process asynchronously, respond immediately
    processComment(repo, comment, commentType, deps).catch((err) =>
      logger.error(
        { err, repo, commentId: comment.id },
        'GitHub webhook: failed to process comment',
      ),
    );

    res.writeHead(200);
    res.end('OK');
  });
}

let server: Server | null = null;
let smeeClient: SmeeClient | null = null;

export function startGitHubWebhook(deps: PRWatcherDeps): void {
  if (!GITHUB_SMEE_URL) {
    return;
  }

  // Start local webhook HTTP server
  server = createServer((req, res) => handleWebhook(req, res, deps));
  server.listen(GITHUB_WEBHOOK_PORT, '127.0.0.1', () => {
    logger.info(
      { port: GITHUB_WEBHOOK_PORT },
      'GitHub webhook server listening',
    );
  });

  // Start smee relay (SSE client that forwards events to our local server)
  smeeClient = new SmeeClient({
    source: GITHUB_SMEE_URL,
    target: `http://127.0.0.1:${GITHUB_WEBHOOK_PORT}/webhook`,
    logger: {
      info: (msg: string) => logger.info({ smee: true }, msg),
      error: (msg: string) => logger.error({ smee: true }, msg),
    },
  });

  smeeClient
    .start()
    .then(() => {
      logger.info(
        { smeeUrl: GITHUB_SMEE_URL, port: GITHUB_WEBHOOK_PORT },
        'GitHub webhook relay (smee) connected and forwarding',
      );
    })
    .catch((err) => {
      logger.error({ err }, 'GitHub webhook relay (smee) failed to connect');
    });

  logger.info(
    { smeeUrl: GITHUB_SMEE_URL, port: GITHUB_WEBHOOK_PORT },
    'GitHub webhook relay (smee) starting',
  );
}

export function stopGitHubWebhook(): void {
  if (smeeClient) {
    smeeClient.stop().catch(() => {});
    smeeClient = null;
  }
  if (server) {
    server.close();
    server = null;
  }
}
