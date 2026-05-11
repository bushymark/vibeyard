import { appState, createDefaultBoard } from './state.js';
import {
  BoardServiceError,
  createBoardTask,
  deleteBoardTask,
  listBoardColumns,
  moveBoardTask,
  searchBoardTasks,
  updateBoardTask,
} from '../shared/board-service.js';
import type { BoardTask, ProjectRecord, SessionRecord } from '../shared/types.js';

interface AgentBoardRequest {
  requestId: string;
  sessionId: string;
  tool: string;
  args: Record<string, unknown>;
}

type AgentBoardResponse =
  | { ok: true; result: unknown }
  | { ok: false; error: { code: string; message: string } };

export function initBoardAgentBridge(): void {
  window.vibeyard.board.onAgentRequest(async (request) => {
    const response = handleRequest(request as AgentBoardRequest);
    window.vibeyard.board.respondAgentRequest(request.requestId, response);
  });
}

function handleRequest(request: AgentBoardRequest): AgentBoardResponse {
  const scope = findSessionScope(request.sessionId);
  if (!scope) {
    return errorResponse('permission_denied', `session not found: ${request.sessionId}`);
  }

  const { project, session } = scope;
  if (!project.board) project.board = createDefaultBoard();

  try {
    switch (request.tool) {
      case 'board_search_items':
        return { ok: true, result: searchBoardTasks(project.board, request.args) };
      case 'board_list_columns':
        return { ok: true, result: listBoardColumns(project.board) };
      case 'board_create_item': {
        const result = createBoardTask(project.board, request.args as Partial<BoardTask>, {
          actorSessionId: request.sessionId,
          providerId: session.providerId,
        });
        appState.notifyBoardChanged();
        return { ok: true, result };
      }
      case 'board_update_item': {
        const taskId = stringArg(request.args, 'taskId');
        const result = updateBoardTask(project.board, taskId, request.args as Partial<BoardTask>, {
          actorSessionId: request.sessionId,
          providerId: session.providerId,
        });
        appState.notifyBoardChanged();
        return { ok: true, result };
      }
      case 'board_move_item': {
        const taskId = stringArg(request.args, 'taskId');
        const result = moveBoardTask(project.board, taskId, request.args, {
          actorSessionId: request.sessionId,
          providerId: session.providerId,
        });
        appState.notifyBoardChanged();
        return { ok: true, result };
      }
      case 'board_delete_item': {
        const taskId = stringArg(request.args, 'taskId');
        const result = deleteBoardTask(project.board, taskId, { confirm: request.args.confirm === true }, {
          actorSessionId: request.sessionId,
          providerId: session.providerId,
        });
        appState.notifyBoardChanged();
        return { ok: true, result };
      }
      default:
        return errorResponse('unknown_tool', `unknown board tool: ${request.tool}`);
    }
  } catch (error) {
    if (error instanceof BoardServiceError) {
      return errorResponse(error.code, error.message);
    }
    if (error instanceof Error) {
      return errorResponse('validation_error', error.message);
    }
    return errorResponse('validation_error', 'board request failed');
  }
}

function findSessionScope(sessionId: string): { project: ProjectRecord; session: SessionRecord } | undefined {
  for (const project of appState.projects) {
    const session = project.sessions.find(s => s.id === sessionId);
    if (session) return { project, session };
  }
  return undefined;
}

function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new BoardServiceError('validation_error', `${key} is required`);
  }
  return value;
}

function errorResponse(code: string, message: string): AgentBoardResponse {
  return { ok: false, error: { code, message } };
}
