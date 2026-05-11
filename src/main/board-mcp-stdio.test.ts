import { afterEach, describe, expect, it, vi } from 'vitest';
import { boardToolDefinitions, callBoardGateway, validateBoardToolArgs } from './board-mcp-stdio';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('board MCP tool definitions', () => {
  it('exposes the v1 board tools', () => {
    expect(boardToolDefinitions.map(t => t.name)).toEqual([
      'board_search_items',
      'board_list_columns',
      'board_create_item',
      'board_update_item',
      'board_move_item',
      'board_delete_item',
    ]);
  });

  it('requires confirm true for delete args', () => {
    expect(() => validateBoardToolArgs('board_delete_item', { taskId: 't1' })).toThrow(/confirm/);
    expect(validateBoardToolArgs('board_delete_item', { taskId: 't1', confirm: true })).toEqual({ taskId: 't1', confirm: true });
  });

  it('declares input schemas for argument-bearing tools', () => {
    const definitions = Object.fromEntries(boardToolDefinitions.map(tool => [tool.name, tool])) as Record<string, any>;
    expect(definitions.board_search_items.inputSchema).toBeDefined();
    expect(definitions.board_create_item.inputSchema.title).toBeDefined();
    expect(definitions.board_update_item.inputSchema.taskId).toBeDefined();
    expect(definitions.board_move_item.inputSchema.taskId).toBeDefined();
    expect(definitions.board_delete_item.inputSchema.confirm).toBeDefined();
  });

  it('throws on gateway error responses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      json: vi.fn().mockResolvedValue({ ok: false, error: { code: 'permission_denied', message: 'invalid board session token' } }),
    }));
    await expect(callBoardGateway('1234', 'token', 'board_search_items', {})).rejects.toThrow('invalid board session token');
  });
});
