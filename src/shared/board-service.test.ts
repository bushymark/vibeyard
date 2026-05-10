import { describe, expect, it } from 'vitest';
import type { BoardData } from './types';
import {
  BoardServiceError,
  createBoardTask,
  deleteBoardTask,
  listBoardColumns,
  moveBoardTask,
  searchBoardTasks,
  updateBoardTask,
} from './board-service';

function board(): BoardData {
  return {
    columns: [
      { id: 'col-backlog', title: 'Backlog', order: 0, behavior: 'inbox' },
      { id: 'col-ready', title: 'Ready', order: 1, behavior: 'none' },
      { id: 'col-running', title: 'Running', order: 2, behavior: 'active' },
      { id: 'col-done', title: 'Done', order: 3, behavior: 'terminal' },
    ],
    tasks: [
      { id: 'task-a', title: 'Alpha', prompt: 'Fix alpha', notes: 'first', columnId: 'col-backlog', order: 0, tags: ['bug'], createdAt: 10, updatedAt: 10 },
      { id: 'task-b', title: 'Beta', prompt: 'Review beta', columnId: 'col-running', order: 0, createdAt: 20, updatedAt: 20 },
    ],
    tags: [{ name: 'bug', color: 'blue' }],
  };
}

const context = { actorSessionId: 'session-1', providerId: 'claude' as const, now: () => 100, id: () => 'task-new' };

describe('BoardService', () => {
  it('creates a task in inbox by default and records audit', () => {
    const data = board();
    const task = createBoardTask(data, { title: 'New', prompt: 'Do it', tags: ['Docs'] }, context);
    expect(task.id).toBe('task-new');
    expect(task.columnId).toBe('col-backlog');
    expect(task.order).toBe(1);
    expect(task.tags).toEqual(['docs']);
    expect(data.tags?.map(t => t.name)).toContain('docs');
    expect(data.audit?.[0]).toMatchObject({ action: 'create', taskId: 'task-new', actorSessionId: 'session-1' });
  });

  it('updates safe fields and rejects linked-session fields', () => {
    const data = board();
    const task = updateBoardTask(data, 'task-a', { title: 'A2', sessionId: 'evil' } as any, context);
    expect(task.title).toBe('A2');
    expect(task.sessionId).toBeUndefined();
    expect(data.audit?.[0]).toMatchObject({ action: 'update', taskId: 'task-a' });
  });

  it('moves tasks when update includes a new columnId', () => {
    const data = board();
    const task = updateBoardTask(data, 'task-a', { columnId: 'col-ready' }, context);
    expect(task.columnId).toBe('col-ready');
    expect(task.order).toBe(0);
    expect(data.tasks.find(t => t.id === 'task-b')?.columnId).toBe('col-running');
  });

  it('moves by semantic state alias', () => {
    const data = board();
    const task = moveBoardTask(data, 'task-a', { state: 'running' }, context);
    expect(task.columnId).toBe('col-running');
    expect(task.order).toBe(0);
    expect(data.tasks.find(t => t.id === 'task-b')?.order).toBe(1);
  });

  it('moves by exact custom column id', () => {
    const data = board();
    const task = moveBoardTask(data, 'task-a', { columnId: 'col-ready', order: 0 }, context);
    expect(task.columnId).toBe('col-ready');
  });

  it('requires confirm true for delete', () => {
    const data = board();
    expect(() => deleteBoardTask(data, 'task-a', { confirm: false }, context)).toThrow(BoardServiceError);
    const tombstone = deleteBoardTask(data, 'task-a', { confirm: true }, context);
    expect(tombstone.taskId).toBe('task-a');
    expect(data.tasks.map(t => t.id)).not.toContain('task-a');
    expect(data.audit?.[0]).toMatchObject({ action: 'delete', taskId: 'task-a' });
  });

  it('searches query, tags, state, and column', () => {
    const data = board();
    expect(searchBoardTasks(data, { query: 'alpha' }).map(t => t.taskId)).toEqual(['task-a']);
    expect(searchBoardTasks(data, { tags: ['bug'] }).map(t => t.taskId)).toEqual(['task-a']);
    expect(searchBoardTasks(data, { state: 'running' }).map(t => t.taskId)).toEqual(['task-b']);
    expect(searchBoardTasks(data, { columnId: 'col-backlog' }).map(t => t.taskId)).toEqual(['task-a']);
  });

  it('lists columns in board order', () => {
    expect(listBoardColumns(board()).map(c => c.columnId)).toEqual(['col-backlog', 'col-ready', 'col-running', 'col-done']);
  });
});
