import { beforeEach, describe, expect, it, vi } from 'vitest';
import { appState, _resetForTesting } from './state';
import { initBoardAgentBridge } from './board-agent-bridge';

const onAgentRequest = vi.fn();
const respondAgentRequest = vi.fn();

beforeEach(() => {
  vi.resetModules();
  onAgentRequest.mockReset();
  respondAgentRequest.mockReset();
  vi.stubGlobal('window', {
    vibeyard: {
      board: { onAgentRequest, respondAgentRequest },
      store: { save: vi.fn() },
    },
  });
  _resetForTesting();
  appState.addProject('Repo', '/repo');
});

describe('board-agent-bridge', () => {
  it('exercises the full agent board tool lifecycle', async () => {
    const project = appState.activeProject!;
    const session = appState.addSession(project.id, 'Agent')!;
    initBoardAgentBridge();
    const handler = onAgentRequest.mock.calls[0][0];

    await handler({ requestId: 'columns', sessionId: session.id, tool: 'board_list_columns', args: {} });
    expect(respondAgentRequest).toHaveBeenCalledWith('columns', {
      ok: true,
      result: expect.arrayContaining([
        expect.objectContaining({ behavior: 'inbox' }),
        expect.objectContaining({ behavior: 'terminal' }),
      ]),
    });
    const inboxColumnId = project.board!.columns.find(c => c.behavior === 'inbox')!.id;
    const doneColumnId = project.board!.columns.find(c => c.behavior === 'terminal')!.id;

    await handler({ requestId: 'create', sessionId: session.id, tool: 'board_create_item', args: { title: 'Lifecycle task', prompt: 'ship the MCP path', notes: 'first note', tags: ['MCP'], state: 'backlog' } });
    const task = project.board!.tasks[0];
    expect(task).toMatchObject({ title: 'Lifecycle task', tags: ['mcp'], columnId: inboxColumnId });

    await handler({ requestId: 'search', sessionId: session.id, tool: 'board_search_items', args: { query: 'ship', tags: ['mcp'] } });
    expect(respondAgentRequest).toHaveBeenCalledWith('search', {
      ok: true,
      result: [expect.objectContaining({ taskId: task.id, title: 'Lifecycle task', columnId: inboxColumnId })],
    });

    await handler({ requestId: 'update', sessionId: session.id, tool: 'board_update_item', args: { taskId: task.id, title: 'Lifecycle task updated', notes: null, planMode: true } });
    expect(project.board!.tasks[0]).toMatchObject({ title: 'Lifecycle task updated', planMode: true });
    expect(project.board!.tasks[0].notes).toBeUndefined();

    await handler({ requestId: 'move', sessionId: session.id, tool: 'board_move_item', args: { taskId: task.id, state: 'done' } });
    expect(project.board!.tasks[0].columnId).toBe(doneColumnId);

    await handler({ requestId: 'delete-rejected', sessionId: session.id, tool: 'board_delete_item', args: { taskId: task.id } });
    expect(respondAgentRequest).toHaveBeenCalledWith('delete-rejected', expect.objectContaining({
      ok: false,
      error: expect.objectContaining({ code: 'validation_error' }),
    }));
    expect(project.board!.tasks).toHaveLength(1);

    await handler({ requestId: 'delete', sessionId: session.id, tool: 'board_delete_item', args: { taskId: task.id, confirm: true } });
    expect(project.board!.tasks).toHaveLength(0);
    expect(project.board!.audit?.map(entry => entry.action)).toEqual(['delete', 'move', 'update', 'create']);
  });

  it('creates a current-project task for a known session request', async () => {
    const project = appState.activeProject!;
    const session = appState.addSession(project.id, 'Agent')!;
    initBoardAgentBridge();
    const handler = onAgentRequest.mock.calls[0][0];
    await handler({ requestId: 'r1', sessionId: session.id, tool: 'board_create_item', args: { title: 'From agent', prompt: 'p' } });
    expect(project.board?.tasks[0].title).toBe('From agent');
    expect(respondAgentRequest).toHaveBeenCalledWith('r1', expect.objectContaining({ ok: true }));
  });

  it('honors create state and requires move for later column changes', async () => {
    const project = appState.activeProject!;
    const session = appState.addSession(project.id, 'Agent')!;
    initBoardAgentBridge();
    const handler = onAgentRequest.mock.calls[0][0];
    await handler({ requestId: 'create', sessionId: session.id, tool: 'board_create_item', args: { title: 'Done from agent', state: 'done' } });
    const task = project.board!.tasks[0];
    expect(task.columnId).toBe(project.board!.columns.find(c => c.behavior === 'terminal')!.id);
    await handler({ requestId: 'update', sessionId: session.id, tool: 'board_update_item', args: { taskId: task.id, columnId: project.board!.columns.find(c => c.behavior === 'inbox')!.id, title: 'Still done' } });
    expect(project.board!.tasks[0].title).toBe('Still done');
    expect(project.board!.tasks[0].columnId).toBe(project.board!.columns.find(c => c.behavior === 'terminal')!.id);
  });

  it('rejects unknown session requests', async () => {
    initBoardAgentBridge();
    const handler = onAgentRequest.mock.calls[0][0];
    await handler({ requestId: 'r2', sessionId: 'missing', tool: 'board_search_items', args: {} });
    expect(respondAgentRequest).toHaveBeenCalledWith('r2', expect.objectContaining({ ok: false, error: expect.objectContaining({ code: 'permission_denied' }) }));
  });

  it('moves and deletes through agent requests', async () => {
    const project = appState.activeProject!;
    const session = appState.addSession(project.id, 'Agent')!;
    project.board!.tasks.push({ id: 'task-1', title: 'Move me', prompt: '', columnId: project.board!.columns[0].id, order: 0, createdAt: 1, updatedAt: 1 });
    initBoardAgentBridge();
    const handler = onAgentRequest.mock.calls[0][0];
    await handler({ requestId: 'move', sessionId: session.id, tool: 'board_move_item', args: { taskId: 'task-1', state: 'done' } });
    expect(project.board!.tasks[0].columnId).toBe(project.board!.columns.find(c => c.behavior === 'terminal')!.id);
    await handler({ requestId: 'delete', sessionId: session.id, tool: 'board_delete_item', args: { taskId: 'task-1', confirm: true } });
    expect(project.board!.tasks).toHaveLength(0);
  });
});
