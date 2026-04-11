# NanoClaw

Personal Claude assistant. See [README.md](README.md) for philosophy and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions.

## Quick Context

Single Node.js process with skill-based channel system. Channels (WhatsApp, Telegram, Slack, Discord, Gmail) are skills that self-register at startup. Messages route to Claude Agent SDK running in containers (Linux VMs). Each group has isolated filesystem and memory.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/channels/registry.ts` | Channel registry (self-registration at startup) |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/router.ts` | Message formatting and outbound routing |
| `src/config.ts` | Trigger pattern, paths, intervals |
| `src/container-runner.ts` | Spawns agent containers with mounts |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | SQLite operations |
| `groups/{name}/CLAUDE.md` | Per-group memory (isolated) |
| `container/skills/` | Skills loaded inside agent containers (browser, status, formatting) |

## Secrets / Credentials / Proxy (OneCLI)

API keys, secret keys, OAuth tokens, and auth credentials are managed by the OneCLI gateway — which handles secret injection into containers at request time, so no keys or tokens are ever passed to containers directly. Run `onecli --help`.

## Skills

Four types of skills exist in NanoClaw. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full taxonomy and guidelines.

- **Feature skills** — merge a `skill/*` branch to add capabilities (e.g. `/add-telegram`, `/add-slack`)
- **Utility skills** — ship code files alongside SKILL.md (e.g. `/claw`)
- **Operational skills** — instruction-only workflows, always on `main` (e.g. `/setup`, `/debug`)
- **Container skills** — loaded inside agent containers at runtime (`container/skills/`)

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |
| `/update-nanoclaw` | Bring upstream NanoClaw updates into a customized install |
| `/start-task` | OpenSpec + TDD workflow for a Kanboard task (spec → red → green → PR) |
| `/finish-task` | Regression check, push branch, open PR, move Kanboard task to Review |
| `/check-regressions` | Run full test suite and report new vs pre-existing failures |
| `/init-onecli` | Install OneCLI Agent Vault and migrate `.env` credentials to it |
| `/qodo-pr-resolver` | Fetch and fix Qodo PR review issues interactively or in batch |
| `/get-qodo-rules` | Load org- and repo-level coding rules from Qodo before code tasks |

## Contributing

Before creating a PR, adding a skill, or preparing any contribution, you MUST read [CONTRIBUTING.md](CONTRIBUTING.md). It covers accepted change types, the four skill types and their guidelines, SKILL.md format rules, PR requirements, and the pre-submission checklist (searching for existing PRs/issues, testing, description format).

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
./container/build.sh # Rebuild agent container
```

Service management:
```bash
# macOS (launchd)
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # restart

# Linux (systemd)
systemctl --user start nanoclaw
systemctl --user stop nanoclaw
systemctl --user restart nanoclaw
```

## Git Remotes

| Remote | URL | Purpose |
|--------|-----|---------|
| `origin` | `git@github.com:IceRhymers/nanoclaw.git` | Your fork (push here) |
| `upstream` | `https://github.com/qwibitai/nanoclaw.git` | Original NanoClaw repo |
| `marketplace` | `https://github.com/IceRhymers/claude-marketplace-builder.git` | Dev-workflow plugin source |

Pull upstream updates: `git fetch upstream && git merge upstream/main`
Update dev-workflow skills: `./scripts/update-dev-workflow.sh`

## Kanboard

Kanboard runs as Docker container `nanoclaw-kanboard` on port 8070. Started automatically by NanoClaw via `ensureKanboardRunning()` in `container-runtime.ts`.

- **API endpoint:** `http://localhost:8070/jsonrpc.php` (containers use `host.docker.internal:8070`)
- **User:** `nanoclaw` / `nanoclaw-api-2026` (must be `app-admin` role — `app-manager` gets 403 on most API methods)
- **Admin:** `admin` / `admin` (default Kanboard admin, use to manage users)
- **Data:** persisted in Docker volumes `kanboard-data` and `kanboard-plugins`
- **MCP server:** `container/agent-runner/src/kanboard-mcp-stdio.ts` — compiled at container startup, provides `mcp__kanboard__*` tools to agents

## Sourcebot (Code Search)

Sourcebot is a self-hosted code search platform, managed independently via `docker compose -f sourcebot/docker-compose.yml up -d`. Agents connect via HTTP MCP when `SOURCEBOT_MCP_URL` and `SOURCEBOT_MCP_TOKEN` are set in `.env`. Port 3000, web UI at `http://localhost:3000`.

## Troubleshooting

**WhatsApp not connecting after upgrade:** WhatsApp is now a separate skill, not bundled in core. Run `/add-whatsapp` (or `npx tsx scripts/apply-skill.ts .claude/skills/add-whatsapp && npm run build`) to install it. Existing auth credentials and groups are preserved.

**Agent reports errors from previous session (repeats old errors without retrying):** The agent has a persistent session and may remember stale errors. To reset: clear the session from `store/messages.db` (`DELETE FROM sessions WHERE group_folder = '<folder>'`) AND delete the session files at `data/sessions/<folder>/.claude/projects/-workspace-group/<session-id>*`. Must do BOTH — deleting files without clearing the DB causes "No conversation found" crash loops.

**Kanboard 403 on API calls:** The Kanboard user must have `app-admin` role. The `app-manager` role returns `{"code":403}` on most JSON-RPC methods (getAllProjects, etc.). Fix: `curl -u admin:admin http://localhost:8070/jsonrpc.php -d '{"jsonrpc":"2.0","method":"updateUser","id":1,"params":{"id":2,"role":"app-admin"}}'`

**Sourcebot MCP not working in agents:** Verify Sourcebot is running (`docker compose -f sourcebot/docker-compose.yml ps`), check that `SOURCEBOT_MCP_URL` and `SOURCEBOT_MCP_TOKEN` are set in `.env`, and ensure repos have finished indexing (check Sourcebot web UI at localhost:3000). Rebuild and restart NanoClaw after adding env vars.

**MCP server changes not taking effect in agent containers:** Agent-runner source is copied to `data/sessions/<group>/agent-runner-src/` and bind-mounted over `/app/src` in the container. Changes to `container/agent-runner/src/` propagate automatically on next container spawn (the source is re-synced each time). If changes still don't appear, check for Docker buildkit cache issues (see below).

## Container Build Cache

The container buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps — the builder's volume retains stale files. To force a truly clean rebuild:

```bash
docker builder prune -af   # nuke ALL build cache
./container/build.sh        # rebuild from scratch
```

## Making Changes Checklist

After editing source files, ALWAYS:
1. `npm run build` — compile TypeScript
2. If `container/agent-runner/src/` was changed: `./container/build.sh` — rebuild agent image
3. `launchctl kickstart -k gui/$(id -u)/com.nanoclaw` — restart the service
4. Changes only take effect in NEW agent containers (existing ones keep old code)
