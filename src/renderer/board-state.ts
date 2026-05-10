import { appState } from './state.js';
import type { BoardTask, BoardColumn, BoardData, ColumnBehavior, TagDefinition } from '../shared/types.js';
import {
  BoardServiceError,
  createBoardTask,
  deleteBoardTask,
  moveBoardTask,
  updateBoardTask,
} from '../shared/board-service.js';

export function getBoard(): BoardData | undefined {
  return appState.activeProject?.board;
}

export function getColumnByBehavior(behavior: ColumnBehavior): BoardColumn | undefined {
  const board = getBoard();
  if (!board) return undefined;
  return board.columns.find(c => c.behavior === behavior);
}

export function getTasksForColumn(columnId: string): BoardTask[] {
  const board = getBoard();
  if (!board) return [];
  return board.tasks
    .filter(t => t.columnId === columnId)
    .sort((a, b) => a.order - b.order);
}

export function getTaskBySessionId(sessionId: string): BoardTask | undefined {
  const board = getBoard();
  if (!board) return undefined;
  return board.tasks.find(t => t.sessionId === sessionId);
}

export function getTaskByCliSessionId(cliSessionId: string): BoardTask | undefined {
  const board = getBoard();
  if (!board) return undefined;
  return board.tasks.find(t => t.cliSessionId === cliSessionId);
}

export function addTask(partial: Partial<BoardTask>): BoardTask | undefined {
  const board = getBoard();
  if (!board) return undefined;

  try {
    const task = createBoardTask(board, partial, uiContext());
    appState.notifyBoardChanged();
    return task;
  } catch (error) {
    if (error instanceof BoardServiceError) return undefined;
    throw error;
  }
}

export function updateTask(taskId: string, updates: Partial<BoardTask>): void {
  const board = getBoard();
  if (!board) return;
  try {
    const task = updateBoardTask(board, taskId, updates, uiContext());
    if ('sessionId' in updates) task.sessionId = updates.sessionId;
    if ('cliSessionId' in updates) task.cliSessionId = updates.cliSessionId;
    appState.notifyBoardChanged();
  } catch (error) {
    if (error instanceof BoardServiceError) return;
    throw error;
  }
}

export function deleteTask(taskId: string): void {
  const board = getBoard();
  if (!board) return;
  try {
    deleteBoardTask(board, taskId, { confirm: true }, uiContext());
    appState.notifyBoardChanged();
  } catch (error) {
    if (error instanceof BoardServiceError) return;
    throw error;
  }
}

export function moveTask(taskId: string, toColumnId: string, toOrder: number): void {
  const board = getBoard();
  if (!board) return;
  try {
    moveBoardTask(board, taskId, { columnId: toColumnId, order: toOrder }, uiContext());
    appState.notifyBoardChanged();
  } catch (error) {
    if (error instanceof BoardServiceError) return;
    throw error;
  }
}

function uiContext() {
  return {
    actorSessionId: appState.activeProject?.activeSessionId ?? 'ui',
    providerId: appState.activeSession?.providerId,
  };
}

export function addColumn(title: string, afterColumnId?: string): BoardColumn | undefined {
  const board = getBoard();
  if (!board) return undefined;

  let insertOrder: number;
  if (afterColumnId) {
    const afterCol = board.columns.find(c => c.id === afterColumnId);
    insertOrder = afterCol ? afterCol.order + 1 : board.columns.length;
  } else {
    insertOrder = board.columns.length;
  }

  // Shift columns at or after insertion point
  board.columns
    .filter(c => c.order >= insertOrder)
    .forEach(c => c.order++);

  const column: BoardColumn = {
    id: crypto.randomUUID(),
    title,
    order: insertOrder,
    behavior: 'none',
  };
  board.columns.push(column);
  appState.notifyBoardChanged();
  return column;
}

export function renameColumn(columnId: string, title: string): void {
  const board = getBoard();
  if (!board) return;
  const column = board.columns.find(c => c.id === columnId);
  if (!column) return;
  column.title = title;
  appState.notifyBoardChanged();
}

export function deleteColumn(columnId: string): void {
  const board = getBoard();
  if (!board) return;

  const column = board.columns.find(c => c.id === columnId);
  if (!column) return;

  // Prevent deleting if it's the last column
  if (board.columns.length <= 1) return;

  // Prevent deleting behavior columns (inbox, active, terminal)
  if (column.behavior !== 'none') return;

  // Move orphaned tasks to inbox column
  const inboxCol = getColumnByBehavior('inbox') ?? board.columns.find(c => c.id !== columnId)!;
  const orphanedTasks = board.tasks.filter(t => t.columnId === columnId);
  const maxInboxOrder = board.tasks
    .filter(t => t.columnId === inboxCol.id)
    .reduce((max, t) => Math.max(max, t.order), -1);

  orphanedTasks.forEach((t, i) => {
    t.columnId = inboxCol.id;
    t.order = maxInboxOrder + 1 + i;
  });

  board.columns = board.columns.filter(c => c.id !== columnId);
  board.columns.sort((a, b) => a.order - b.order).forEach((c, i) => c.order = i);

  appState.notifyBoardChanged();
}

export function reorderColumns(columnIds: string[]): void {
  const board = getBoard();
  if (!board) return;
  for (let i = 0; i < columnIds.length; i++) {
    const col = board.columns.find(c => c.id === columnIds[i]);
    if (col) col.order = i;
  }
  appState.notifyBoardChanged();
}

export const TAG_COLORS = ['blue', 'green', 'amber', 'red', 'purple', 'cyan', 'pink', 'gray'];

export function addTag(name: string, color?: string): TagDefinition | undefined {
  const board = getBoard();
  if (!board) return undefined;
  if (!board.tags) board.tags = [];

  const normalized = name.toLowerCase().trim();
  if (board.tags.some(t => t.name === normalized)) return board.tags.find(t => t.name === normalized);

  const tagColor = color ?? TAG_COLORS[board.tags.length % TAG_COLORS.length];
  const tag: TagDefinition = { name: normalized, color: tagColor };
  board.tags.push(tag);
  appState.notifyBoardChanged();
  return tag;
}

export function removeTag(name: string): void {
  const board = getBoard();
  if (!board || !board.tags) return;

  const normalized = name.toLowerCase().trim();
  board.tags = board.tags.filter(t => t.name !== normalized);
  for (const task of board.tasks) {
    if (task.tags) {
      task.tags = task.tags.filter(t => t !== normalized);
    }
  }
  appState.notifyBoardChanged();
}

export function updateTagColor(name: string, color: string): void {
  const board = getBoard();
  if (!board || !board.tags) return;

  const normalized = name.toLowerCase().trim();
  const tag = board.tags.find(t => t.name === normalized);
  if (tag) {
    tag.color = color;
    appState.notifyBoardChanged();
  }
}

export function addTagToTask(taskId: string, tagName: string): void {
  const board = getBoard();
  if (!board) return;
  const task = board.tasks.find(t => t.id === taskId);
  if (!task) return;

  const normalized = tagName.toLowerCase().trim();
  if (!normalized) return;

  // Auto-create the tag in the palette if it doesn't exist
  addTag(normalized);

  if (!task.tags) task.tags = [];
  if (task.tags.includes(normalized)) return;
  task.tags.push(normalized);
  task.updatedAt = Date.now();
  appState.notifyBoardChanged();
}

export function removeTagFromTask(taskId: string, tagName: string): void {
  const board = getBoard();
  if (!board) return;
  const task = board.tasks.find(t => t.id === taskId);
  if (!task || !task.tags) return;

  const normalized = tagName.toLowerCase().trim();
  task.tags = task.tags.filter(t => t !== normalized);
  task.updatedAt = Date.now();
  appState.notifyBoardChanged();
}

export function getTagColor(tagName: string): string {
  const board = getBoard();
  const tag = board?.tags?.find(t => t.name === tagName);
  return tag?.color ?? 'gray';
}

export function getTagCount(tagName: string): number {
  const board = getBoard();
  if (!board) return 0;
  return board.tasks.filter(t => t.tags?.includes(tagName)).length;
}
