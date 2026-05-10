import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

export const boardToolDefinitions = [
  { name: 'board_search_items', description: 'Search current-project Vibeyard board items' },
  { name: 'board_list_columns', description: 'List current-project Vibeyard board columns' },
  { name: 'board_create_item', description: 'Create a current-project Vibeyard board item' },
  { name: 'board_update_item', description: 'Update a current-project Vibeyard board item by taskId' },
  { name: 'board_move_item', description: 'Move a current-project Vibeyard board item by taskId' },
  { name: 'board_delete_item', description: 'Delete a current-project Vibeyard board item by taskId with confirm true' },
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
  if (!response.ok) throw new Error(`Board gateway failed: ${response.status}`);
  return response.json();
}

export async function startBoardMcpStdioServer(): Promise<void> {
  const token = process.env.VIBEYARD_BOARD_SESSION_TOKEN;
  const port = process.env.VIBEYARD_BOARD_MCP_PORT;
  if (!token) throw new Error('VIBEYARD_BOARD_SESSION_TOKEN is required');
  if (!port) throw new Error('VIBEYARD_BOARD_MCP_PORT is required');

  const server = new McpServer({ name: 'vibeyard-board', version: '1.0.0' });
  for (const definition of boardToolDefinitions) {
    server.registerTool(definition.name, { description: definition.description }, async (args) => {
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

if (require.main === module) {
  startBoardMcpStdioServer().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
