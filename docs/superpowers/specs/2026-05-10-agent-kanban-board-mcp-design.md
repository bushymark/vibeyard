# Agent Kanban Board MCP Design

## Purpose

Vibeyard should let code agents running inside Vibeyard-managed sessions interact with the current project's Kanban board through a structured tool surface. Version 1 supports creating, editing, deleting, moving, and searching board items. The surface is for in-session agents only; it is not a general external automation API.

## Scope

V1 includes:

- Current-project-only board access.
- Stable task IDs for all mutations.
- MCP tools exposed to supported in-session CLI providers.
- Silent writes with persistent audit records.
- Semantic movement by default board states and exact movement by column ID.
- Confirm-required single-item deletion.

V1 excludes:

- Cross-project board access.
- Bulk mutation.
- Title-based edit or delete.
- Undo.
- External script/API access.
- Optimistic concurrency or compare-and-set writes.

## Architecture

The preferred architecture is a local Vibeyard Board MCP surface backed by a shared board mutation service.

### Components

**BoardService**

Owns board validation and mutation rules. It should be the contract used by both agent calls and, over time, renderer UI actions. It owns:

- Task creation defaults.
- Column and semantic-state resolution.
- Order normalization.
- Tag normalization and palette creation.
- Safe update fields.
- Delete validation.
- Audit entry creation.

It refuses to know about provider-specific MCP schemas or DOM rendering.

**Board MCP Adapter**

Exposes BoardService through MCP tools. It owns:

- Tool names and JSON schemas.
- Mapping tool arguments to BoardService calls.
- Mapping service errors to structured MCP errors.
- Binding each request to the Vibeyard session and current project.

It refuses to mutate app state directly.

**Session/Project Scope Resolver**

Maps a tool call to the Vibeyard session that launched the agent and then to that session's project. V1 must not accept arbitrary `projectId` from the agent. The implementation should use a session-scoped token injected into the provider process environment when Vibeyard launches the session.

It refuses cross-project access.

**Audit Store**

Records every agent-initiated write. Each entry should include:

- Timestamp.
- Vibeyard session ID.
- Provider ID when known.
- Action name.
- Task ID.
- Before/after summary for edits and moves.
- Tombstone summary for deletes.

The UI can expose this minimally in v1, but the data should be persisted with the project board state or an adjacent per-project audit structure.

## Tool Contract

### `board_search_items`

Search board tasks in the current project.

Inputs:

- `query?: string` searches title, prompt, and notes.
- `tags?: string[]` matches any listed tag.
- `state?: "inbox" | "backlog" | "active" | "running" | "terminal" | "done"` filters by semantic state.
- `columnId?: string` filters by exact column.
- `includeDone?: boolean` controls whether terminal tasks are included when no explicit state/column is provided.
- `limit?: number` caps result count.

Returns task summaries with:

- `taskId`
- `title`
- `promptSnippet`
- `notesSnippet`
- `tags`
- `columnId`
- `columnTitle`
- `state`
- `sessionId`
- `cliSessionId`
- `providerId`
- `planMode`
- `createdAt`
- `updatedAt`

### `board_list_columns`

List board columns for the current project. This is required so agents can target custom columns without guessing.

Returns:

- `columnId`
- `title`
- `order`
- `behavior`
- `locked`

### `board_create_item`

Create a board task in the current project.

Inputs:

- `title: string`
- `prompt?: string`
- `notes?: string`
- `tags?: string[]`
- `providerId?: ProviderId`
- `planMode?: boolean`
- `state?: semantic state`
- `columnId?: string`

If both `columnId` and `state` are present, `columnId` wins. If neither is present, the task is created in the inbox/backlog behavior column, falling back to the first column if no inbox column exists.

Returns the created task summary.

### `board_update_item`

Patch an existing board task.

Inputs:

- `taskId: string`
- `title?: string`
- `prompt?: string`
- `notes?: string | null`
- `tags?: string[]`
- `providerId?: ProviderId`
- `planMode?: boolean`

V1 rejects updates to `id`, `createdAt`, `updatedAt`, `sessionId`, `cliSessionId`, and ordering fields. Moving between columns must use `board_move_item`.

Returns the updated task summary.

### `board_move_item`

Move an existing task to another column or semantic state.

Inputs:

- `taskId: string`
- `columnId?: string`
- `state?: semantic state`
- `order?: number`

Semantic aliases:

- `inbox`, `backlog` map to the column with behavior `inbox`.
- `active`, `running` map to the column with behavior `active`.
- `terminal`, `done` map to the column with behavior `terminal`.

If both `columnId` and `state` are present, `columnId` wins. If `order` is omitted, the task moves to the top of the target column.

Returns the updated task summary.

### `board_delete_item`

Delete one task.

Inputs:

- `taskId: string`
- `confirm: true`

The tool must reject requests without `confirm: true`. It must not support title-based delete or bulk delete in v1.

Returns a tombstone summary with `taskId`, previous title, previous column, tags, and deletion timestamp.

## Data Flow

1. Vibeyard launches a provider session and injects the session/project binding needed by the Board MCP surface.
2. The provider discovers the Vibeyard board MCP tools.
3. The agent calls a board tool.
4. The MCP adapter validates the request schema and resolves the calling session to the current project.
5. BoardService applies validation and mutation against the project board.
6. The mutation emits the normal board-changed notification path so open Kanban surfaces refresh.
7. The audit store records the write.
8. The MCP adapter returns a structured result.

## Error Handling

Errors should be structured and specific:

- `not_found`: task or column does not exist.
- `invalid_state`: semantic state cannot be resolved because the project lacks the matching behavior column.
- `validation_error`: required fields are missing or invalid.
- `permission_denied`: request is not bound to a known Vibeyard session or tries to cross project boundaries.
- `conflict`: reserved for future compare-and-set behavior; v1 does not need to emit it.

The board UI remains usable if the MCP surface is unavailable. In that failure mode, agents lose board tools but existing user-driven board behavior continues.

## Security and Boundaries

The agent should not be allowed to pass a project ID in v1. The server derives scope from the launched session. This prevents accidental or hostile cross-project writes.

The MCP adapter should treat all text inputs as untrusted. It should preserve text as board content but never interpolate text into shell commands or file paths.

Delete is intentionally stricter than create/edit/move. It requires a task ID and `confirm: true`, and it creates a tombstone audit record.

## Migration From Current Code

Today, board mutations live in renderer `board-state.ts` and operate on `appState.activeProject`. The v1 implementation should introduce BoardService without forcing a full renderer rewrite. A practical sequence:

1. Extract pure board operations and validation from `board-state.ts` into a service module.
2. Keep existing renderer functions as thin wrappers that call the service against `appState.activeProject`.
3. Add the MCP adapter and session/project resolver.
4. Add audit persistence.
5. Optionally migrate board UI components to call the service directly in later cleanup.

This avoids direct state-file editing and avoids a second set of board mutation rules.

## Tests

Unit tests should cover BoardService:

- Create defaults.
- Safe update fields.
- Delete requires explicit confirmation at adapter level.
- Move by column ID.
- Move by semantic state aliases.
- Invalid state and missing task errors.
- Tag normalization.
- Order normalization.
- Audit entry creation.

MCP adapter tests should cover:

- Tool schema validation.
- Current-project scoping from session binding.
- Rejection of cross-project inputs.
- Structured error mapping.
- Result shape for search/list/create/update/move/delete.

Existing board UI tests should continue to pass. As board mutation logic moves into BoardService, tests that currently target `board-state.ts` should either remain wrapper tests or move down to the service.

## Open Decisions

No open product decisions remain for v1. The session binding mechanism is part of the design: Vibeyard injects a session-scoped token into the provider process environment, and the Board MCP surface uses that token to resolve the current project.
