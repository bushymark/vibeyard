import { describe, expect, it } from 'vitest';
import { boardToolDefinitions, validateBoardToolArgs } from './board-mcp-stdio';

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
});
