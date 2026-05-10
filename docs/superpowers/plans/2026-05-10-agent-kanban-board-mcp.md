# Agent Kanban Board MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let agents running inside Vibeyard-managed CLI sessions create, edit, remove, move, and search current-project Kanban board items through MCP tools.

**Architecture:** Add a shared `BoardService` that owns board mutations and audit records. Expose it to in-session agents through a stdio MCP server that inherits a session token from the spawned CLI environment and proxies requests back to the running Electron app through a loopback gateway. Keep renderer `appState` as the live source of truth for v1, so board UI refresh and debounced persistence continue to work through existing paths.

**Tech Stack:** TypeScript 5.7, Electron IPC, Node loopback HTTP, `@modelcontextprotocol/sdk`, Vitest 4.

---

## File Structure

- Create `src/shared/board-service.ts`: pure board query/mutation service with no DOM, Electron, or provider knowledge.
- Create `src/shared/board-service.test.ts`: service coverage for create, update, move, delete, search, tags, ordering, and audit generation.
- Modify `src/shared/types.ts`: add board audit types and `BoardData.audit`.
- Modify `src/renderer/board-state.ts`: keep current exported API but delegate mutation rules to `BoardService`.
- Modify `src/renderer/board-state.test.ts`: assert wrapper behavior still matches existing UI expectations.
- Create `src/renderer/board-agent-bridge.ts`: renderer handler for authenticated board tool requests from main.
- Modify `src/renderer/index.ts`: initialize the board agent bridge.
- Modify `src/preload/preload.ts` and `src/renderer/types.ts`: expose a board request/response IPC bridge.
- Create `src/main/board-mcp-gateway.ts`: loopback gateway, session token registry, renderer request forwarding, provider config installer.
- Create `src/main/board-mcp-gateway.test.ts`: gateway token and provider config tests.
- Create `src/main/board-mcp-stdio.ts`: MCP stdio server process that exposes board tools and calls the gateway with inherited env.
- Create `src/main/board-mcp-stdio.test.ts`: tool schema and gateway proxy tests with mocked HTTP.
- Modify `src/main/main.ts`: start and stop the gateway with app lifecycle.
- Modify `src/main/pty-manager.ts`: inject session token/port env and ensure provider MCP config before spawning a CLI.
- Modify `src/main/providers/provider.ts`: add optional provider hook if provider-specific MCP config installation needs to move behind the provider boundary.
- Modify `src/main/providers/*.ts` only if the provider hook is used.

---

### Task 1: Add Board Audit Types And BoardService

**Files:**
- Modify: `src/shared/types.ts:181`
- Create: `src/shared/board-service.ts`
- Test: `src/shared/board-service.test.ts`

- [ ] **Step 1: Write failing service tests**

Create `src/shared/board-service.test.ts` with focused tests:

```ts
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
```

- [ ] **Step 2: Run the failing service tests**

Run: `npm test -- src/shared/board-service.test.ts`

Expected: FAIL because `src/shared/board-service.ts` does not exist.

- [ ] **Step 3: Add board audit types**

Modify `src/shared/types.ts` near the board interfaces:

```ts
export type BoardAuditAction = 'create' | 'update' | 'move' | 'delete';

export interface BoardAuditEntry {
  id: string;
  action: BoardAuditAction;
  taskId: string;
  actorSessionId: string;
  providerId?: ProviderId;
  createdAt: number;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  tombstone?: {
    title: string;
    columnId: string;
    tags?: string[];
  };
}

export interface BoardData {
  columns: BoardColumn[];
  tasks: BoardTask[];
  tags?: TagDefinition[];
  audit?: BoardAuditEntry[];
}
```

- [ ] **Step 4: Implement BoardService**

Create `src/shared/board-service.ts` with these exports and signatures:

```ts
import type { BoardAuditEntry, BoardColumn, BoardData, BoardTask, ColumnBehavior, ProviderId, TagDefinition } from './types';

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
    id: input.id ?? context.id?.() ?? crypto.randomUUID(),
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
```

Add the private helpers in the same file: `resolveColumn`, `behaviorForState`, `findTask`, `columnForTask`, `summarizeTask`, `snippet`, `normalizeTags`, `ensureTags`, `nextOrder`, `shiftOut`, `shiftIn`, `snapshotTask`, and `appendAudit`. Keep them pure and deterministic.

- [ ] **Step 5: Run service tests**

Run: `npm test -- src/shared/board-service.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit Task 1**

```bash
git add src/shared/types.ts src/shared/board-service.ts src/shared/board-service.test.ts
git commit -m "feat: add board mutation service"
```

---

### Task 2: Route Existing Renderer Board Mutations Through BoardService

**Files:**
- Modify: `src/renderer/board-state.ts`
- Test: `src/renderer/board-state.test.ts`

- [ ] **Step 1: Add wrapper regression tests**

Extend `src/renderer/board-state.test.ts` with tests that current exports still notify and preserve active-project behavior:

```ts
it('addTask records audit and notifies board change', () => {
  const spy = vi.fn();
  appState.on('board-changed', spy);
  const task = addTask({ title: 'Audit me', prompt: 'p' })!;
  expect(task.title).toBe('Audit me');
  expect(getBoard()!.audit?.[0]).toMatchObject({ action: 'create', taskId: task.id });
  expect(spy).toHaveBeenCalled();
});

it('moveTask delegates ordering to BoardService', () => {
  const t1 = addTask({ title: 'One', prompt: 'p', columnId: 'col-backlog' })!;
  const t2 = addTask({ title: 'Two', prompt: 'p', columnId: 'col-backlog' })!;
  moveTask(t2.id, 'col-running', 0);
  moveTask(t1.id, 'col-running', 0);
  const running = getBoard()!.tasks.filter(t => t.columnId === 'col-running').sort((a, b) => a.order - b.order);
  expect(running.map(t => t.id)).toEqual([t1.id, t2.id]);
});
```

- [ ] **Step 2: Run wrapper tests to capture current failure**

Run: `npm test -- src/renderer/board-state.test.ts`

Expected: FAIL on the new audit assertion before `board-state.ts` delegates to `BoardService`.

- [ ] **Step 3: Refactor `board-state.ts` wrappers**

Update the mutation functions to call `BoardService` while preserving their current return values and `appState.notifyBoardChanged()` behavior:

```ts
import {
  createBoardTask,
  deleteBoardTask,
  moveBoardTask,
  updateBoardTask,
} from '../shared/board-service.js';
```

Use a local context helper:

```ts
function uiContext() {
  return {
    actorSessionId: appState.activeProject?.activeSessionId ?? 'ui',
    providerId: appState.activeSession?.providerId,
  };
}
```

Map wrappers:

```ts
export function addTask(partial: Partial<BoardTask>): BoardTask | undefined {
  const board = getBoard();
  if (!board) return undefined;
  const task = createBoardTask(board, partial, uiContext());
  appState.notifyBoardChanged();
  return task;
}
```

```ts
export function updateTask(taskId: string, updates: Partial<BoardTask>): void {
  const board = getBoard();
  if (!board) return;
  updateBoardTask(board, taskId, updates, uiContext());
  appState.notifyBoardChanged();
}
```

```ts
export function deleteTask(taskId: string): void {
  const board = getBoard();
  if (!board) return;
  deleteBoardTask(board, taskId, { confirm: true }, uiContext());
  appState.notifyBoardChanged();
}
```

```ts
export function moveTask(taskId: string, toColumnId: string, toOrder: number): void {
  const board = getBoard();
  if (!board) return;
  moveBoardTask(board, taskId, { columnId: toColumnId, order: toOrder }, uiContext());
  appState.notifyBoardChanged();
}
```

Catch `BoardServiceError` in wrappers and return without throwing to preserve current UI no-op behavior for missing tasks or invalid columns.

- [ ] **Step 4: Run renderer board tests**

Run: `npm test -- src/renderer/board-state.test.ts src/renderer/board-session-sync.test.ts src/renderer/components/board/board-dnd.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit Task 2**

```bash
git add src/renderer/board-state.ts src/renderer/board-state.test.ts
git commit -m "refactor: route board state through service"
```

---

### Task 3: Add Renderer Agent Board Bridge

**Files:**
- Create: `src/renderer/board-agent-bridge.ts`
- Modify: `src/renderer/index.ts`
- Modify: `src/preload/preload.ts`
- Modify: `src/renderer/types.ts`
- Test: `src/renderer/board-agent-bridge.test.ts`

- [ ] **Step 1: Write failing bridge tests**

Create `src/renderer/board-agent-bridge.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { appState } from './state';
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
  appState.resetForTesting();
  appState.addProject('/repo');
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
});
```

- [ ] **Step 2: Run failing bridge tests**

Run: `npm test -- src/renderer/board-agent-bridge.test.ts`

Expected: FAIL because the bridge file and preload board API do not exist.

- [ ] **Step 3: Extend preload API**

In `src/preload/preload.ts`, add:

```ts
board: {
  onAgentRequest(callback: (request: { requestId: string; sessionId: string; tool: string; args: Record<string, unknown> }) => void | Promise<void>): () => void;
  respondAgentRequest(requestId: string, response: unknown): void;
};
```

In the `api` object:

```ts
board: {
  onAgentRequest: (callback) =>
    onChannel('board:agentRequest', (request) => callback(request as { requestId: string; sessionId: string; tool: string; args: Record<string, unknown> })),
  respondAgentRequest: (requestId, response) =>
    ipcRenderer.send('board:agentResponse', requestId, response),
},
```

Mirror the same shape in `src/renderer/types.ts`.

- [ ] **Step 4: Implement bridge dispatch**

Create `src/renderer/board-agent-bridge.ts`:

```ts
import { appState } from './state.js';
import {
  createBoardTask,
  deleteBoardTask,
  listBoardColumns,
  moveBoardTask,
  searchBoardTasks,
  updateBoardTask,
  BoardServiceError,
} from '../shared/board-service.js';

interface AgentBoardRequest {
  requestId: string;
  sessionId: string;
  tool: string;
  args: Record<string, unknown>;
}

export function initBoardAgentBridge(): void {
  window.vibeyard.board.onAgentRequest(async (request) => {
    const response = handleRequest(request as AgentBoardRequest);
    window.vibeyard.board.respondAgentRequest(request.requestId, response);
  });
}
```

Implement `handleRequest()` so it:

- Finds the project containing `request.sessionId`.
- Ensures `project.board` exists.
- Builds context `{ actorSessionId: request.sessionId, providerId: session.providerId }`.
- Calls the matching BoardService function.
- Calls `appState.notifyBoardChanged()` after create/update/move/delete.
- Calls `appState.persist()` or the existing state save path used by board notifications if `notifyBoardChanged()` already persists.
- Returns `{ ok: true, result }` or `{ ok: false, error: { code, message } }`.

- [ ] **Step 5: Initialize bridge**

In `src/renderer/index.ts`, import and initialize:

```ts
import { initBoardAgentBridge } from './board-agent-bridge.js';
```

Call it next to board initialization:

```ts
initBoard();
initBoardSessionSync();
initBoardAgentBridge();
```

- [ ] **Step 6: Run bridge and renderer tests**

Run: `npm test -- src/renderer/board-agent-bridge.test.ts src/renderer/board-state.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit Task 3**

```bash
git add src/preload/preload.ts src/renderer/types.ts src/renderer/index.ts src/renderer/board-agent-bridge.ts src/renderer/board-agent-bridge.test.ts
git commit -m "feat: add renderer board agent bridge"
```

---

### Task 4: Add Main Gateway, Session Tokens, And Provider MCP Config Installation

**Files:**
- Create: `src/main/board-mcp-gateway.ts`
- Test: `src/main/board-mcp-gateway.test.ts`
- Modify: `src/main/main.ts`
- Modify: `src/main/pty-manager.ts`

- [ ] **Step 1: Write failing gateway tests**

Create `src/main/board-mcp-gateway.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  createBoardSessionBinding,
  resolveBoardSessionToken,
  ensureProviderBoardMcpConfig,
  resetBoardMcpGatewayForTesting,
} from './board-mcp-gateway';

vi.mock('fs');
vi.mock('os');

afterEach(() => resetBoardMcpGatewayForTesting());

describe('board-mcp-gateway session bindings', () => {
  it('creates and resolves a session token', () => {
    const token = createBoardSessionBinding('session-1');
    expect(resolveBoardSessionToken(token)).toEqual({ sessionId: 'session-1' });
  });
});

describe('ensureProviderBoardMcpConfig', () => {
  it('writes Claude project .mcp.json with the board server command', () => {
    vi.mocked(os.homedir).mockReturnValue('/home/me');
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const writes: Array<[string, string]> = [];
    vi.mocked(fs.mkdirSync).mockImplementation(() => undefined as any);
    vi.mocked(fs.writeFileSync).mockImplementation((file, data) => { writes.push([String(file), String(data)]); });
    ensureProviderBoardMcpConfig('claude', '/repo', '/dist/main/board-mcp-stdio.js');
    expect(writes[0][0]).toBe(path.join('/repo', '.mcp.json'));
    expect(JSON.parse(writes[0][1]).mcpServers['vibeyard-board']).toMatchObject({ command: 'node', args: ['/dist/main/board-mcp-stdio.js'] });
  });
});
```

- [ ] **Step 2: Run failing gateway tests**

Run: `npm test -- src/main/board-mcp-gateway.test.ts`

Expected: FAIL because `board-mcp-gateway.ts` does not exist.

- [ ] **Step 3: Implement session binding and config installers**

Create `src/main/board-mcp-gateway.ts` with exports:

```ts
import { BrowserWindow } from 'electron';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import type { ProviderId } from '../shared/types';

const SERVER_NAME = 'vibeyard-board';
const bindings = new Map<string, { sessionId: string }>();
let server: http.Server | null = null;
let port: number | null = null;

export function createBoardSessionBinding(sessionId: string): string {
  const token = crypto.randomBytes(24).toString('hex');
  bindings.set(token, { sessionId });
  return token;
}

export function resolveBoardSessionToken(token: string): { sessionId: string } | null {
  return bindings.get(token) ?? null;
}

export function getBoardMcpGatewayPort(): number | null {
  return port;
}
```

Add `startBoardMcpGateway(win: BrowserWindow): Promise<number>`, `stopBoardMcpGateway(): Promise<void>`, and `forwardBoardToolRequest(win, sessionId, tool, args)`. Use a request ID, `win.webContents.send('board:agentRequest', request)`, and wait for `ipcMain` response on `board:agentResponse`.

Add `ensureProviderBoardMcpConfig(providerId, projectPath, serverScriptPath)` that writes:

- Claude: `<projectPath>/.mcp.json`
- Copilot: `<projectPath>/.copilot/mcp-config.json`
- Gemini: `<projectPath>/.gemini/settings.json`
- Codex: `<projectPath>/.codex/config.toml`

Each JSON config should contain:

```json
{
  "mcpServers": {
    "vibeyard-board": {
      "command": "node",
      "args": ["/absolute/path/to/dist/main/board-mcp-stdio.js"]
    }
  }
}
```

Codex TOML should contain:

```toml
[mcp_servers.vibeyard-board]
command = "node"
args = ["/absolute/path/to/dist/main/board-mcp-stdio.js"]
```

Preserve existing config keys by reading and merging JSON/TOML sections. For Codex, append or replace only the `[mcp_servers.vibeyard-board]` block.

- [ ] **Step 4: Start gateway from main**

In `src/main/main.ts`, start the gateway after the main window is created:

```ts
import { startBoardMcpGateway, stopBoardMcpGateway } from './board-mcp-gateway';
```

Call:

```ts
await startBoardMcpGateway(mainWindow);
```

On app quit/cleanup:

```ts
await stopBoardMcpGateway();
```

- [ ] **Step 5: Inject env and install provider config in `pty-manager.ts`**

Import gateway helpers:

```ts
import { createBoardSessionBinding, ensureProviderBoardMcpConfig, getBoardMcpGatewayPort, boardMcpServerScriptPath } from './board-mcp-gateway';
```

Before `pty.spawn`, after provider hooks:

```ts
ensureProviderBoardMcpConfig(providerId, cwd, boardMcpServerScriptPath());
const token = createBoardSessionBinding(sessionId);
const env = provider.buildEnv(sessionId, { ...process.env } as Record<string, string>);
env.VIBEYARD_BOARD_SESSION_TOKEN = token;
env.VIBEYARD_BOARD_MCP_PORT = String(getBoardMcpGatewayPort() ?? '');
```

Keep the existing provider `buildArgs` and spawn flow intact.

- [ ] **Step 6: Run gateway tests and main typecheck**

Run: `npm test -- src/main/board-mcp-gateway.test.ts`

Expected: PASS.

Run: `npm run build`

Expected: PASS.

- [ ] **Step 7: Commit Task 4**

```bash
git add src/main/board-mcp-gateway.ts src/main/board-mcp-gateway.test.ts src/main/main.ts src/main/pty-manager.ts
git commit -m "feat: add board MCP gateway"
```

---

### Task 5: Add Board MCP Stdio Server

**Files:**
- Create: `src/main/board-mcp-stdio.ts`
- Test: `src/main/board-mcp-stdio.test.ts`

- [ ] **Step 1: Write failing stdio server tests**

Create `src/main/board-mcp-stdio.test.ts`:

```ts
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
```

- [ ] **Step 2: Run failing stdio tests**

Run: `npm test -- src/main/board-mcp-stdio.test.ts`

Expected: FAIL because `board-mcp-stdio.ts` does not exist.

- [ ] **Step 3: Implement tool definitions and validation**

Create `src/main/board-mcp-stdio.ts` with exported definitions:

```ts
export const boardToolDefinitions = [
  { name: 'board_search_items', description: 'Search current-project Vibeyard board items' },
  { name: 'board_list_columns', description: 'List current-project Vibeyard board columns' },
  { name: 'board_create_item', description: 'Create a current-project Vibeyard board item' },
  { name: 'board_update_item', description: 'Update a current-project Vibeyard board item by taskId' },
  { name: 'board_move_item', description: 'Move a current-project Vibeyard board item by taskId' },
  { name: 'board_delete_item', description: 'Delete a current-project Vibeyard board item by taskId with confirm true' },
] as const;
```

Add `validateBoardToolArgs(tool, args)` with explicit runtime checks:

- `board_create_item`: requires non-empty `title`.
- `board_update_item`: requires non-empty `taskId`.
- `board_move_item`: requires `taskId` and either `columnId` or `state`.
- `board_delete_item`: requires `taskId` and `confirm === true`.
- Search/list accept empty args.

- [ ] **Step 4: Implement MCP server main**

Use `@modelcontextprotocol/sdk` stdio transport. The server should:

- Read `VIBEYARD_BOARD_SESSION_TOKEN`.
- Read `VIBEYARD_BOARD_MCP_PORT`.
- Register all six tools.
- On call, validate args.
- POST `{ token, tool, args }` to `http://127.0.0.1:${port}/board-tool`.
- Return structured JSON content from the gateway result.

Keep the tool-call proxy in a separate exported function:

```ts
export async function callBoardGateway(port: string, token: string, tool: string, args: Record<string, unknown>): Promise<unknown> {
  const response = await fetch(`http://127.0.0.1:${port}/board-tool`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token, tool, args }),
  });
  if (!response.ok) throw new Error(`Board gateway failed: ${response.status}`);
  return response.json();
}
```

- [ ] **Step 5: Run stdio tests and build**

Run: `npm test -- src/main/board-mcp-stdio.test.ts`

Expected: PASS.

Run: `npm run build`

Expected: PASS and `dist/main/board-mcp-stdio.js` exists.

- [ ] **Step 6: Commit Task 5**

```bash
git add src/main/board-mcp-stdio.ts src/main/board-mcp-stdio.test.ts
git commit -m "feat: expose board MCP tools"
```

---

### Task 6: Add End-To-End Renderer/Main Tests For Agent Tool Calls

**Files:**
- Modify: `src/main/board-mcp-gateway.test.ts`
- Modify: `src/renderer/board-agent-bridge.test.ts`

- [ ] **Step 1: Add a gateway forwarding test**

Extend `src/main/board-mcp-gateway.test.ts` with a fake `BrowserWindow`:

```ts
it('forwards authenticated tool calls to renderer', async () => {
  const sent: unknown[] = [];
  const win = { webContents: { send: vi.fn((_channel, payload) => sent.push(payload)) } } as any;
  const token = createBoardSessionBinding('session-1');
  const promise = forwardBoardToolRequestForTesting(win, token, 'board_search_items', {});
  const request = sent[0] as { requestId: string };
  resolveBoardAgentResponseForTesting(request.requestId, { ok: true, result: [] });
  await expect(promise).resolves.toEqual({ ok: true, result: [] });
});
```

- [ ] **Step 2: Add a renderer dispatch test for move and delete**

Extend `src/renderer/board-agent-bridge.test.ts`:

```ts
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
```

- [ ] **Step 3: Run integration tests**

Run: `npm test -- src/main/board-mcp-gateway.test.ts src/renderer/board-agent-bridge.test.ts`

Expected: PASS.

- [ ] **Step 4: Commit Task 6**

```bash
git add src/main/board-mcp-gateway.test.ts src/renderer/board-agent-bridge.test.ts
git commit -m "test: cover board MCP request flow"
```

---

### Task 7: Documentation, Build Verification, And Agent Orientation

**Files:**
- Modify: `AGENTS.md`
- Modify: `CLAUDE.md`
- Modify: `docs/superpowers/specs/2026-05-10-agent-kanban-board-mcp-design.md` if implementation discoveries require design correction.

- [ ] **Step 1: Update agent docs**

Add a short section to both `AGENTS.md` and `CLAUDE.md`:

```md
### Agent Kanban board MCP surface

Vibeyard exposes current-project Kanban board operations to in-session agents through the managed `vibeyard-board` MCP server. The tool surface is scoped by a session token injected when Vibeyard launches the CLI provider. Agents can search, list columns, create, update, move, and delete single board tasks. Deletes require `confirm: true`; cross-project access and bulk mutation are intentionally unsupported.
```

- [ ] **Step 2: Run focused tests**

Run:

```bash
npm test -- src/shared/board-service.test.ts src/renderer/board-state.test.ts src/renderer/board-agent-bridge.test.ts src/main/board-mcp-gateway.test.ts src/main/board-mcp-stdio.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run full build**

Run: `npm run build`

Expected: PASS.

- [ ] **Step 4: Run full test suite**

Run: `npm test`

Expected: PASS.

- [ ] **Step 5: Commit Task 7**

```bash
git add AGENTS.md CLAUDE.md docs/superpowers/specs/2026-05-10-agent-kanban-board-mcp-design.md
git commit -m "docs: document board MCP surface"
```

---

## Final Verification

- [ ] Run `npm run build`.
- [ ] Run `npm test`.
- [ ] Start Vibeyard with `npm start`.
- [ ] Create a board task from the UI and run it in a provider session.
- [ ] In that provider session, confirm the `vibeyard-board` MCP tools are visible.
- [ ] Call `board_search_items` and confirm the UI-created task appears.
- [ ] Call `board_create_item` and confirm the Kanban tab refreshes.
- [ ] Call `board_move_item` with `{ "state": "done" }` and confirm the card moves to Done.
- [ ] Call `board_delete_item` without `confirm` and confirm it fails.
- [ ] Call `board_delete_item` with `confirm: true` and confirm the card is removed and an audit entry is persisted.

---

## Plan Self-Review

Spec coverage:

- Current-project-only scope is implemented by the session token resolver in Task 4 and bridge session lookup in Task 3.
- Create, update, delete, move, search, and list columns are implemented by BoardService in Task 1 and exposed by the MCP server in Task 5.
- Silent writes with audit are implemented in Task 1.
- Semantic and exact movement are covered in Task 1 tests.
- Delete confirmation is covered in Task 1 and Task 5 tests.
- Existing UI behavior is preserved by Task 2 wrapper tests.

Placeholder scan:

- The plan contains no placeholder tasks. Each task names exact files, commands, and expected outcomes.

Type consistency:

- Tool names match the design spec.
- Shared service names are reused consistently by renderer bridge and tests.
- `taskId`, `columnId`, `sessionId`, and `providerId` naming follows existing project types.
