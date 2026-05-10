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
  it('creates a current-project task for a known session request', async () => {
    const project = appState.activeProject!;
    const session = appState.addSession(project.id, 'Agent')!;
    initBoardAgentBridge();
    const handler = onAgentRequest.mock.calls[0][0];
    await handler({ requestId: 'r1', sessionId: session.id, tool: 'board_create_item', args: { title: 'From agent', prompt: 'p' } });
    expect(project.board?.tasks[0].title).toBe('From agent');
    expect(respondAgentRequest).toHaveBeenCalledWith('r1', expect.objectContaining({ ok: true }));
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
