/**
 * Kanboard MCP Server (stdio)
 *
 * Thin MCP bridge that wraps Kanboard's JSON-RPC API.
 * Runs inside NanoClaw agent containers, calls Kanboard via HTTP.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const KANBOARD_URL = process.env.KANBOARD_URL || 'http://host.docker.internal:8070/jsonrpc.php';
const KANBOARD_USER = process.env.KANBOARD_USER || 'nanoclaw';
const KANBOARD_TOKEN = process.env.KANBOARD_TOKEN || 'nanoclaw-api-2026';

let rpcId = 1;

async function rpc(method: string, params?: Record<string, unknown>): Promise<unknown> {
  const body = { jsonrpc: '2.0', method, id: rpcId++, params: params || {} };
  const auth = Buffer.from(`${KANBOARD_USER}:${KANBOARD_TOKEN}`).toString('base64');

  const res = await fetch(KANBOARD_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Basic ${auth}` },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Kanboard API ${res.status}: ${text}`);
  }

  const json = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (json.error) throw new Error(`Kanboard RPC error: ${json.error.message}`);
  return json.result;
}

function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

const server = new McpServer({ name: 'kanboard', version: '1.0.0' });

// ── Projects ──────────────────────────────────────────────

server.tool(
  'kb_get_all_projects',
  'List all Kanboard projects.',
  {},
  async () => ok(await rpc('getAllProjects')),
);

server.tool(
  'kb_get_project',
  'Get a project by ID.',
  { project_id: z.number() },
  async ({ project_id }) => ok(await rpc('getProjectById', { project_id })),
);

server.tool(
  'kb_create_project',
  'Create a new project.',
  {
    name: z.string(),
    description: z.string().optional(),
  },
  async ({ name, description }) => ok(await rpc('createProject', { name, description })),
);

server.tool(
  'kb_update_project',
  'Update a project (name, description).',
  {
    project_id: z.number(),
    name: z.string().optional(),
    description: z.string().optional(),
  },
  async (args) => ok(await rpc('updateProject', args)),
);

server.tool(
  'kb_remove_project',
  'Delete a project.',
  { project_id: z.number() },
  async ({ project_id }) => ok(await rpc('removeProject', { project_id })),
);

// ── Columns ───────────────────────────────────────────────

server.tool(
  'kb_get_columns',
  'Get all columns for a project (the board structure).',
  { project_id: z.number() },
  async ({ project_id }) => ok(await rpc('getColumns', { project_id })),
);

server.tool(
  'kb_add_column',
  'Add a column to a project.',
  {
    project_id: z.number(),
    title: z.string(),
    task_limit: z.number().optional(),
  },
  async (args) => ok(await rpc('addColumn', args)),
);

server.tool(
  'kb_update_column',
  'Update a column (title, task_limit, description).',
  {
    column_id: z.number(),
    title: z.string(),
    task_limit: z.number().optional(),
  },
  async (args) => ok(await rpc('updateColumn', args)),
);

// ── Board ─────────────────────────────────────────────────

server.tool(
  'kb_get_board',
  'Get the full board (columns with swimlanes and tasks) for a project.',
  { project_id: z.number() },
  async ({ project_id }) => ok(await rpc('getBoard', { project_id })),
);

// ── Tasks ─────────────────────────────────────────────────

server.tool(
  'kb_get_all_tasks',
  'Get all tasks for a project. status_id: 1=open, 0=closed.',
  {
    project_id: z.number(),
    status_id: z.number().optional(),
  },
  async ({ project_id, status_id }) =>
    ok(await rpc('getAllTasks', { project_id, status_id: status_id ?? 1 })),
);

server.tool(
  'kb_get_task',
  'Get a single task by ID.',
  { task_id: z.number() },
  async ({ task_id }) => ok(await rpc('getTask', { task_id })),
);

server.tool(
  'kb_create_task',
  'Create a task. Provide project_id, title, and optionally: column_id, description, color_id, priority, date_due, assignee.',
  {
    project_id: z.number(),
    title: z.string(),
    column_id: z.number().optional(),
    swimlane_id: z.number().optional(),
    description: z.string().optional(),
    color_id: z.string().optional(),
    priority: z.number().optional(),
    date_due: z.string().optional(),
    owner_id: z.number().optional(),
    tags: z.array(z.string()).optional(),
  },
  async (args) => ok(await rpc('createTask', args)),
);

server.tool(
  'kb_update_task',
  'Update a task (title, description, column_id, color_id, priority, date_due, etc.).',
  {
    id: z.number(),
    title: z.string().optional(),
    description: z.string().optional(),
    column_id: z.number().optional(),
    swimlane_id: z.number().optional(),
    color_id: z.string().optional(),
    priority: z.number().optional(),
    date_due: z.string().optional(),
    owner_id: z.number().optional(),
    tags: z.array(z.string()).optional(),
  },
  async (args) => ok(await rpc('updateTask', args)),
);

server.tool(
  'kb_move_task',
  'Move a task to a different column (and optionally swimlane). position=1 for top.',
  {
    project_id: z.number(),
    task_id: z.number(),
    column_id: z.number(),
    position: z.number(),
    swimlane_id: z.number().optional(),
  },
  async ({ swimlane_id, ...args }) =>
    ok(await rpc('moveTaskPosition', { swimlane_id: swimlane_id ?? 1, ...args })),
);

server.tool(
  'kb_close_task',
  'Close (complete) a task.',
  { task_id: z.number() },
  async ({ task_id }) => ok(await rpc('closeTask', { task_id })),
);

server.tool(
  'kb_open_task',
  'Reopen a closed task.',
  { task_id: z.number() },
  async ({ task_id }) => ok(await rpc('openTask', { task_id })),
);

server.tool(
  'kb_remove_task',
  'Delete a task permanently.',
  { task_id: z.number() },
  async ({ task_id }) => ok(await rpc('removeTask', { task_id })),
);

server.tool(
  'kb_search_tasks',
  'Search tasks in a project by query string.',
  {
    project_id: z.number(),
    query: z.string(),
  },
  async ({ project_id, query }) => ok(await rpc('searchTasks', { project_id, query })),
);

server.tool(
  'kb_get_overdue_tasks',
  'Get all overdue tasks across all projects.',
  {},
  async () => ok(await rpc('getOverdueTasks')),
);

// ── Comments ──────────────────────────────────────────────

server.tool(
  'kb_get_all_comments',
  'Get all comments on a task.',
  { task_id: z.number() },
  async ({ task_id }) => ok(await rpc('getAllComments', { task_id })),
);

server.tool(
  'kb_create_comment',
  'Add a comment to a task.',
  {
    task_id: z.number(),
    content: z.string(),
    user_id: z.number().optional(),
  },
  async (args) => ok(await rpc('createComment', args)),
);

// ── Subtasks ──────────────────────────────────────────────

server.tool(
  'kb_get_all_subtasks',
  'Get all subtasks for a task.',
  { task_id: z.number() },
  async ({ task_id }) => ok(await rpc('getAllSubtasks', { task_id })),
);

server.tool(
  'kb_create_subtask',
  'Create a subtask.',
  {
    task_id: z.number(),
    title: z.string(),
  },
  async (args) => ok(await rpc('createSubtask', args)),
);

// ── Categories ────────────────────────────────────────────

server.tool(
  'kb_get_all_categories',
  'Get all categories for a project.',
  { project_id: z.number() },
  async ({ project_id }) => ok(await rpc('getAllCategories', { project_id })),
);

server.tool(
  'kb_create_category',
  'Create a category in a project.',
  {
    project_id: z.number(),
    name: z.string(),
  },
  async (args) => ok(await rpc('createCategory', args)),
);

// ── Swimlanes ─────────────────────────────────────────────

server.tool(
  'kb_get_active_swimlanes',
  'Get active swimlanes for a project.',
  { project_id: z.number() },
  async ({ project_id }) => ok(await rpc('getActiveSwimlanes', { project_id })),
);

// ── Tags ──────────────────────────────────────────────────

server.tool(
  'kb_get_all_tags',
  'Get all tags for a project.',
  { project_id: z.number() },
  async ({ project_id }) => ok(await rpc('getAllTags', { project_id })),
);

// ── Dashboard ─────────────────────────────────────────────

server.tool(
  'kb_get_my_dashboard',
  'Get the dashboard for the current user (tasks, projects, subtasks, activity).',
  {},
  async () => ok(await rpc('getMyDashboard')),
);

// ── Start ─────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[kanboard-mcp] Connected to Kanboard at', KANBOARD_URL);
}

main().catch((err) => {
  console.error('[kanboard-mcp] Fatal:', err);
  process.exit(1);
});
