import type {
  BoardAuditAction,
  BoardAuditEntry,
  BoardColumn,
  BoardData,
  BoardTask,
  ColumnBehavior,
  ProviderId,
  TagDefinition,
} from './types';

export type BoardSemanticState = 'inbox' | 'backlog' | 'active' | 'running' | 'terminal' | 'done';

export type BoardServiceErrorCode = 'not_found' | 'invalid_state' | 'validation_error';

export class BoardServiceError extends Error {
  constructor(readonly code: BoardServiceErrorCode, message: string) {
    super(message);
    this.name = 'BoardServiceError';
  }
}

export interface BoardMutationContext {
  actorSessionId: string;
  providerId?: ProviderId;
  now?: () => number;
  id?: () => string;
}

export interface BoardTaskSummary {
  taskId: string;
  title: string;
  promptSnippet: string;
  notesSnippet?: string;
  tags: string[];
  columnId: string;
  columnTitle: string;
  state: ColumnBehavior;
  sessionId?: string;
  cliSessionId?: string;
  providerId?: ProviderId;
  planMode?: boolean;
  createdAt: number;
  updatedAt: number;
}

const TAG_COLORS = ['blue', 'green', 'amber', 'red', 'purple', 'cyan', 'pink', 'gray'];

export function listBoardColumns(board: BoardData): Array<{ columnId: string; title: string; order: number; behavior: ColumnBehavior; locked?: boolean }> {
  return [...board.columns].sort((a, b) => a.order - b.order).map(c => ({
    columnId: c.id,
    title: c.title,
    order: c.order,
    behavior: c.behavior,
    locked: c.locked,
  }));
}

export function searchBoardTasks(board: BoardData, input: { query?: string; tags?: string[]; state?: BoardSemanticState; columnId?: string; includeDone?: boolean; limit?: number }): BoardTaskSummary[] {
  const query = input.query?.toLowerCase().trim();
  const tags = normalizeTags(input.tags ?? []);
  const columnId = input.columnId ?? (input.state ? resolveColumn(board, { state: input.state }).id : undefined);
  const limit = input.limit && input.limit > 0 ? input.limit : 50;
  return board.tasks
    .filter(task => !columnId || task.columnId === columnId)
    .filter(task => input.includeDone || input.state || input.columnId || columnForTask(board, task)?.behavior !== 'terminal')
    .filter(task => !query || `${task.title}\n${task.prompt}\n${task.notes ?? ''}`.toLowerCase().includes(query))
    .filter(task => tags.length === 0 || task.tags?.some(tag => tags.includes(tag)))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, limit)
    .map(task => summarizeTask(board, task));
}

export function createBoardTask(board: BoardData, input: Partial<BoardTask>, context: BoardMutationContext): BoardTask {
  const title = input.title?.trim();
  if (!title) throw new BoardServiceError('validation_error', 'title is required');
  const column = resolveColumn(board, { columnId: input.columnId, state: input.columnId ? undefined : 'inbox' });
  const now = context.now?.() ?? Date.now();
  const task: BoardTask = {
    id: input.id ?? context.id?.() ?? randomId(),
    title,
    prompt: input.prompt ?? '',
    ...(input.notes ? { notes: input.notes } : {}),
    columnId: column.id,
    order: nextOrder(board, column.id),
    ...(input.providerId ? { providerId: input.providerId } : {}),
    ...(input.planMode !== undefined ? { planMode: input.planMode } : {}),
    createdAt: input.createdAt ?? now,
    updatedAt: now,
  };
  const tags = normalizeTags(input.tags ?? []);
  if (tags.length > 0) task.tags = ensureTags(board, tags);
  board.tasks.push(task);
  appendAudit(board, 'create', task.id, context, undefined, snapshotTask(task));
  return task;
}

export function updateBoardTask(board: BoardData, taskId: string, input: Partial<BoardTask>, context: BoardMutationContext): BoardTask {
  const task = findTask(board, taskId);
  const before = snapshotTask(task);
  if (input.title !== undefined) {
    const title = input.title.trim();
    if (!title) throw new BoardServiceError('validation_error', 'title is required');
    task.title = title;
  }
  if (input.prompt !== undefined) task.prompt = input.prompt;
  if ('notes' in input) task.notes = input.notes || undefined;
  if (input.providerId !== undefined) task.providerId = input.providerId;
  if (input.planMode !== undefined) task.planMode = input.planMode;
  if (input.tags !== undefined) task.tags = ensureTags(board, normalizeTags(input.tags));
  task.updatedAt = context.now?.() ?? Date.now();
  appendAudit(board, 'update', task.id, context, before, snapshotTask(task));
  return task;
}

export function moveBoardTask(board: BoardData, taskId: string, input: { columnId?: string; state?: BoardSemanticState; order?: number }, context: BoardMutationContext): BoardTask {
  const task = findTask(board, taskId);
  const before = snapshotTask(task);
  const target = resolveColumn(board, input);
  const order = Math.max(0, input.order ?? 0);
  shiftOut(board, task);
  shiftIn(board, target.id, order, task.id);
  task.columnId = target.id;
  task.order = order;
  task.updatedAt = context.now?.() ?? Date.now();
  appendAudit(board, 'move', task.id, context, before, snapshotTask(task));
  return task;
}

export function deleteBoardTask(board: BoardData, taskId: string, input: { confirm?: boolean }, context: BoardMutationContext): { taskId: string; title: string; columnId: string; tags?: string[]; deletedAt: number } {
  if (input.confirm !== true) throw new BoardServiceError('validation_error', 'confirm true is required');
  const task = findTask(board, taskId);
  const deletedAt = context.now?.() ?? Date.now();
  const tombstone = { taskId: task.id, title: task.title, columnId: task.columnId, tags: task.tags, deletedAt };
  shiftOut(board, task);
  board.tasks = board.tasks.filter(t => t.id !== task.id);
  appendAudit(board, 'delete', task.id, context, snapshotTask(task), undefined, { title: task.title, columnId: task.columnId, tags: task.tags });
  return tombstone;
}

function resolveColumn(board: BoardData, input: { columnId?: string; state?: BoardSemanticState }): BoardColumn {
  if (input.columnId) {
    const column = board.columns.find(c => c.id === input.columnId);
    if (!column) throw new BoardServiceError('not_found', `column not found: ${input.columnId}`);
    return column;
  }
  if (input.state) {
    const behavior = behaviorForState(input.state);
    const column = board.columns
      .filter(c => c.behavior === behavior)
      .sort((a, b) => a.order - b.order)[0];
    if (!column) throw new BoardServiceError('invalid_state', `state has no matching column: ${input.state}`);
    return column;
  }
  throw new BoardServiceError('validation_error', 'columnId or state is required');
}

function behaviorForState(state: BoardSemanticState): ColumnBehavior {
  switch (state) {
    case 'inbox':
    case 'backlog':
      return 'inbox';
    case 'active':
    case 'running':
      return 'active';
    case 'terminal':
    case 'done':
      return 'terminal';
  }
}

function findTask(board: BoardData, taskId: string): BoardTask {
  const task = board.tasks.find(t => t.id === taskId);
  if (!task) throw new BoardServiceError('not_found', `task not found: ${taskId}`);
  return task;
}

function columnForTask(board: BoardData, task: BoardTask): BoardColumn | undefined {
  return board.columns.find(c => c.id === task.columnId);
}

function summarizeTask(board: BoardData, task: BoardTask): BoardTaskSummary {
  const column = columnForTask(board, task);
  return {
    taskId: task.id,
    title: task.title,
    promptSnippet: snippet(task.prompt),
    ...(task.notes ? { notesSnippet: snippet(task.notes) } : {}),
    tags: task.tags ?? [],
    columnId: task.columnId,
    columnTitle: column?.title ?? task.columnId,
    state: column?.behavior ?? 'none',
    ...(task.sessionId ? { sessionId: task.sessionId } : {}),
    ...(task.cliSessionId ? { cliSessionId: task.cliSessionId } : {}),
    ...(task.providerId ? { providerId: task.providerId } : {}),
    ...(task.planMode !== undefined ? { planMode: task.planMode } : {}),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

function snippet(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > 180 ? `${trimmed.slice(0, 177)}...` : trimmed;
}

function normalizeTags(tags: string[]): string[] {
  return [...new Set(tags.map(tag => tag.toLowerCase().trim()).filter(Boolean))];
}

function ensureTags(board: BoardData, tags: string[]): string[] {
  if (!board.tags) board.tags = [];
  for (const tag of tags) {
    if (!board.tags.some(existing => existing.name === tag)) {
      board.tags.push({ name: tag, color: nextTagColor(board.tags) });
    }
  }
  return tags;
}

function nextTagColor(tags: TagDefinition[]): string {
  return TAG_COLORS[tags.length % TAG_COLORS.length];
}

function nextOrder(board: BoardData, columnId: string): number {
  return board.tasks
    .filter(t => t.columnId === columnId)
    .reduce((max, task) => Math.max(max, task.order), -1) + 1;
}

function shiftOut(board: BoardData, task: BoardTask): void {
  board.tasks
    .filter(t => t.id !== task.id && t.columnId === task.columnId && t.order > task.order)
    .forEach(t => t.order--);
}

function shiftIn(board: BoardData, columnId: string, order: number, taskId: string): void {
  board.tasks
    .filter(t => t.id !== taskId && t.columnId === columnId && t.order >= order)
    .forEach(t => t.order++);
}

function snapshotTask(task: BoardTask): Record<string, unknown> {
  return {
    id: task.id,
    title: task.title,
    prompt: task.prompt,
    ...(task.notes ? { notes: task.notes } : {}),
    columnId: task.columnId,
    order: task.order,
    ...(task.sessionId ? { sessionId: task.sessionId } : {}),
    ...(task.cliSessionId ? { cliSessionId: task.cliSessionId } : {}),
    ...(task.providerId ? { providerId: task.providerId } : {}),
    ...(task.planMode !== undefined ? { planMode: task.planMode } : {}),
    ...(task.tags ? { tags: [...task.tags] } : {}),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

function appendAudit(
  board: BoardData,
  action: BoardAuditAction,
  taskId: string,
  context: BoardMutationContext,
  before?: Record<string, unknown>,
  after?: Record<string, unknown>,
  tombstone?: BoardAuditEntry['tombstone'],
): void {
  if (!board.audit) board.audit = [];
  board.audit.unshift({
    id: context.id?.() ?? randomId(),
    action,
    taskId,
    actorSessionId: context.actorSessionId,
    ...(context.providerId ? { providerId: context.providerId } : {}),
    createdAt: context.now?.() ?? Date.now(),
    ...(before ? { before } : {}),
    ...(after ? { after } : {}),
    ...(tombstone ? { tombstone } : {}),
  });
}

function randomId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `board-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
