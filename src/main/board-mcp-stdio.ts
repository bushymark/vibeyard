import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';

export const boardToolDefinitions = [
  {
    name: 'board_search_items',
    description: 'Search current-project Vibeyard board items',
    inputSchema: {
      query: z.string().optional(),
      tags: z.array(z.string()).optional(),
      state: z.enum(['inbox', 'backlog', 'active', 'running', 'terminal', 'done']).optional(),
      columnId: z.string().optional(),
      includeDone: z.boolean().optional(),
      limit: z.number().optional(),
    },
  },
  {
    name: 'board_list_columns',
    description: 'List current-project Vibeyard board columns',
    inputSchema: {},
  },
  {
    name: 'board_create_item',
    description: 'Create a current-project Vibeyard board item',
    inputSchema: {
      title: z.string(),
      prompt: z.string().optional(),
      notes: z.string().optional(),
      tags: z.array(z.string()).optional(),
      state: z.enum(['inbox', 'backlog', 'active', 'running', 'terminal', 'done']).optional(),
      columnId: z.string().optional(),
      planMode: z.boolean().optional(),
    },
  },
  {
    name: 'board_update_item',
    description: 'Update a current-project Vibeyard board item by taskId',
    inputSchema: {
      taskId: z.string(),
      title: z.string().optional(),
      prompt: z.string().optional(),
      notes: z.string().nullable().optional(),
      tags: z.array(z.string()).optional(),
      planMode: z.boolean().optional(),
    },
  },
  {
    name: 'board_move_item',
    description: 'Move a current-project Vibeyard board item by taskId',
    inputSchema: {
      taskId: z.string(),
      columnId: z.string().optional(),
      state: z.enum(['inbox', 'backlog', 'active', 'running', 'terminal', 'done']).optional(),
      order: z.number().optional(),
    },
  },
  {
    name: 'board_delete_item',
    description: 'Delete a current-project Vibeyard board item by taskId with confirm true',
    inputSchema: {
      taskId: z.string(),
      confirm: z.boolean(),
    },
  },
] as const;

type BoardToolName = typeof boardToolDefinitions[number]['name'];

export function validateBoardToolArgs(tool: string, args: unknown): Record<string, unknown> {
  const input = isRecord(args) ? args : {};
  switch (tool) {
    case 'board_search_items':
    case 'board_list_columns':
      return input;
    case 'board_create_item':
      requireString(input, 'title');
      return input;
    case 'board_update_item':
      requireString(input, 'taskId');
      return input;
    case 'board_move_item':
      requireString(input, 'taskId');
      if (!isNonEmptyString(input.columnId) && !isNonEmptyString(input.state)) {
        throw new Error('columnId or state is required');
      }
      return input;
    case 'board_delete_item':
      requireString(input, 'taskId');
      if (input.confirm !== true) throw new Error('confirm true is required');
      return input;
    default:
      throw new Error(`unknown board tool: ${tool}`);
  }
}

export async function callBoardGateway(port: string, token: string, tool: string, args: Record<string, unknown>): Promise<unknown> {
  const response = await fetch(`http://127.0.0.1:${port}/board-tool`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token, tool, args }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = isErrorPayload(payload) ? payload.error.message : `Board gateway failed: ${response.status}`;
    const error = new Error(message);
    (error as Error & { code?: string }).code = isErrorPayload(payload) ? payload.error.code : undefined;
    throw error;
  }
  return payload;
}

export async function startBoardMcpStdioServer(): Promise<void> {
  const token = process.env.VIBEYARD_BOARD_SESSION_TOKEN;
  const port = process.env.VIBEYARD_BOARD_MCP_PORT;
  if (!token) throw new Error('VIBEYARD_BOARD_SESSION_TOKEN is required');
  if (!port) throw new Error('VIBEYARD_BOARD_MCP_PORT is required');

  const server = new McpServer({ name: 'vibeyard-board', version: '1.0.0' });
  for (const definition of boardToolDefinitions) {
    server.registerTool(definition.name, { description: definition.description, inputSchema: definition.inputSchema }, async (args: Record<string, unknown>) => {
      const validated = validateBoardToolArgs(definition.name, args);
      const result = await callBoardGateway(port, token, definition.name, validated);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    });
  }

  await server.connect(new StdioServerTransport());
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (!isNonEmptyString(value)) throw new Error(`${key} is required`);
  return value;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isErrorPayload(value: unknown): value is { ok: false; error: { code: string; message: string } } {
  return isRecord(value)
    && value.ok === false
    && isRecord(value.error)
    && typeof value.error.code === 'string'
    && typeof value.error.message === 'string';
}

if (require.main === module) {
  startBoardMcpStdioServer().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
