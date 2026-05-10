# AGENTS.md

Orientation for any coding agent working in this repo.

## What this is

Vibeyard is a terminal-centric IDE desktop app built on Electron. It wraps CLI tool sessions — each session is a PTY running a CLI tool (Claude Code today, with an abstraction layer for Codex CLI, Copilot CLI, and Gemini CLI) — and renders them via xterm.js. Users manage projects, sessions, a kanban board, a team of personas, and a customizable per-project Overview page.

## Tech stack

- **Runtime:** Electron 41, Node `>=18` (developer machines pin v24 via `.nvmrc`)
- **Language:** TypeScript 5.7 across all three Electron processes
- **UI:** Vanilla TypeScript + DOM (no framework). xterm.js for terminals, gridstack.js for the Overview grid
- **Bundler:** `tsc` for main and preload (CommonJS); `esbuild` for the renderer (IIFE, ES2022, sourcemaps)
- **Tests:** Vitest 4 with v8 coverage. Tests are co-located as `*.test.ts`
- **Packaging:** electron-builder. Targets macOS (`dmg`, `zip`), Linux (`AppImage`, `deb`), Windows (`nsis`, `portable`)
- **No lint or formatter is configured.** Don't introduce one without discussion

## Getting started

```bash
nvm use            # picks Node v24 from .nvmrc
npm install        # postinstall runs `electron-builder install-app-deps` (rebuilds node-pty)
npm run build      # tsc main + tsc preload + esbuild renderer + copy assets
npm start          # alias: npm run dev — builds then launches Electron
```

There is **no hot reload.** Any change requires a rebuild and an app restart.

## Tests

```bash
npm test               # one-shot
npm run test:watch     # watch mode
npm run test:coverage  # text + HTML report at coverage/index.html
```

- Tests are co-located with source as `*.test.ts`
- Test files are excluded from production builds (see `tsconfig.main.json` / `tsconfig.renderer.json`)
- Three renderer modules (`session-cost.ts`, `session-activity.ts`, `session-context.ts`) expose `_resetForTesting()` to clear module-level state between tests
- Main-process tests mock `fs`, `child_process`, `node-pty`, and `os` via `vi.mock()`

## Packaging

```bash
npm run pack    # build + electron-builder --dir (unpacked, for local testing)
npm run dist    # build + electron-builder (full installers)
```

The electron-builder config lives inline in `package.json` under `"build"`. CI builds and tests on macOS, Linux, and Windows, so platform-specific code paths must work on all three.

## Architecture

Three-process Electron app with strict context isolation:

- **Main process** (`src/main/`) — Node side. Owns window creation, PTY lifecycle (`node-pty`), filesystem access, and persistent state at `~/.vibeyard/state.json`. IPC entry point is `ipc-handlers.ts`, which dispatches to `pty-manager.ts`, `store.ts`, the provider registry, and so on.
- **Preload** (`src/preload/preload.ts`) — Secure bridge. Exposes the `window.vibeyard` API via `contextBridge` with namespaces: `pty`, `session`, `store`, `fs`, `provider`, `menu`, `github`, `stats`, etc. A second preload (`browser-tab-preload.ts`) services the embedded browser tab.
- **Renderer** (`src/renderer/`) — DOM UI. `AppState` singleton in `state.ts` is an event emitter; components in `components/` subscribe to state changes and re-render their slice.

### Data flow

Renderer → IPC invoke/send → Main → PTY / filesystem / external CLI → IPC send back → Renderer updates xterm or the relevant DOM.

### Build targets

Each process has its own tsconfig:

- `tsconfig.main.json` (CommonJS, Node target) → `dist/main/`
- `tsconfig.preload.json` (CommonJS) → `dist/preload/`
- `tsconfig.renderer.json` (used for type-checking; esbuild does the bundling) → `dist/renderer/`
- `tsconfig.test.json` (test-only)
- `tsconfig.json` is the base

Asset copying happens in `scripts/copy-assets.js` (HTML, CSS, xterm.css, gridstack.min.css, icons, CHANGELOG, provider assets).

### CLI provider system

CLI-specific behavior is encapsulated behind the `CliProvider` interface in `src/main/providers/provider.ts`. Each provider handles binary resolution, env vars, args, hooks, config reading, and cleanup. Providers register at startup in `src/main/providers/registry.ts`.

- **Per-session:** every `SessionRecord` has a `providerId` (defaults to `'claude'`). One project can host sessions from multiple providers.
- **Capabilities:** providers declare features via `CliProviderCapabilities`; UI conditionally enables features per-session.
- **Current providers:** `claude-provider.ts`, `codex-provider.ts`, `copilot-provider.ts`, `gemini-provider.ts`.
- **System prompt:** `buildArgs` accepts an optional `systemPrompt`. Providers map it to their CLI's flag (Claude: `--append-system-prompt`; Codex: `-c developer_instructions=…`; Copilot/Gemini: `--system-prompt`). The renderer hands it over via `pendingSystemPrompt` on `SessionRecord`, which is consumed once and stripped from `state.json`.
- **Agent files:** providers expose `agentsDir()`, `installAgent(slug, content)`, `removeAgent(slug)`. Default impls live in `providers/agent-files.ts`. The Team feature uses these to mirror a `TeamMember` (with `installAsAgent: true`) as `<slug>.md` (Copilot uses `.agent.md`) under each provider's user-global agents dir.

### State persistence

App state (projects, sessions, layout, team, board) persists to `~/.vibeyard/state.json` via `src/main/store.ts`. Saves are debounced and flushed on quit. Sessions track `cliSessionId` for resume.

## Key file locations

### Main process

- `src/main/main.ts` — app entry, window creation
- `src/main/ipc-handlers.ts` — IPC dispatch surface
- `src/main/pty-manager.ts` — PTY lifecycle, env var setup, resume
- `src/main/store.ts` — persistent state (`~/.vibeyard/state.json`)
- `src/main/providers/` — CLI provider implementations and registry
- `src/main/platform.ts` — **the** source of truth for platform detection
- `src/main/github-cli.ts` — wraps the user's local `gh` for the GitHub widgets
- `src/main/hook-status.ts`, `claude-cli.ts`, `prerequisites.ts` — Claude-specific helpers
- `src/main/menu.ts`, `auto-updater.ts`, `file-watcher.ts`, `git-watcher.ts`

### Renderer

- `src/renderer/index.ts` — entry
- `src/renderer/state.ts` — `AppState` singleton + event emitter; debounced 300ms persist
- `src/renderer/components/terminal-pane.ts` — xterm.js wrapper, WebGL with software fallback
- `src/renderer/components/split-layout.ts` — tab vs split mode
- `src/renderer/components/sidebar.ts`, `tab-bar.ts`, `modal.ts`, `custom-select.ts`
- `src/renderer/components/board/` — kanban board UI
- `src/renderer/components/team/` — team members, predefined picker, member modal
- `src/renderer/components/project-tab/` — Overview page (gridstack-based widgets)
- `src/renderer/components/browser-tab/` — embedded browser tab
- `src/renderer/board-state.ts`, `board-filter.ts`, `board-session-sync.ts` — board logic
- `src/renderer/session-activity.ts`, `session-cost.ts`, `session-context.ts` — per-session telemetry (each exposes `_resetForTesting()`)
- `src/renderer/styles/` — CSS by domain (kanban, team, widgets, etc.). All styles use CSS variables; no hardcoded colors

### Shared

- `src/shared/types.ts` — `SessionRecord`, `ProjectRecord`, `TeamMember`, etc.
- `src/shared/platform.ts` — renderer-safe platform helpers
- `src/shared/team-config.ts` — `TEAM_MEMBERS_REPO` constant for predefined personas
- `src/shared/constants.ts`, `slug.ts`, `project-name.ts`

## Coding conventions

### Platform checks

Import `isWin` / `isMac` / `isLinux` (and `pathSep`, `whichCmd`, `pythonBin`) from `src/main/platform.ts`. **Do not** inline `process.platform === 'win32'` or redefine these locally. The three-way managed-path branch in `claude-cli.ts` is the one intentional exception.

### Cross-platform paths in tests

Never hardcode forward-slash literals when asserting on a path the implementation produced via `path.join`/`resolve`/`normalize` — they pass on macOS/Linux and silently fail on Windows CI. Build the expected value with the same primitive:

```ts
import * as path from 'path';
expect(mockRm).toHaveBeenCalledWith(path.join('/repo', 'foo.ts'), opts); // good
expect(mockRm).toHaveBeenCalledWith('/repo/foo.ts', opts);               // bad
```

### UI / renderer

- Never use the native `<select>` — use `components/custom-select.ts`
- Never hardcode colors — use the CSS variables defined in `styles/`
- Reuse existing modals, dropdowns, alerts, badges, and the `showModal` helper rather than re-rolling them
- The Overview page is widget-driven; add features there by registering a new widget in `components/project-tab/widgets/widget-registry.ts`

### State

- Mutate `appState` in place and call the matching `notify*` method (e.g. `appState.notifyBoardChanged()`); subscribers re-render off the event
- Don't persist transient fields — `pendingSystemPrompt` is the canonical example of "consume once, strip before save"

### Git workflow

- Never commit, push, or open a PR unless explicitly asked
- When asked to commit, use the project's `/commit` slash command rather than crafting a commit by hand

### After implementing a change

1. Run `/simplify` to review the diff for reuse and quality
2. Add or update tests to cover the change
3. If the change touches architecture, build pipeline, IPC namespaces, or key components, update **both** this file and `CLAUDE.md` so the next agent walks in oriented

## Where the deep dive lives

`CLAUDE.md` in the repo root has more detail on individual subsystems (board internals, widget registry, the Team feature, GitHub widgets, etc.). This file covers the orientation every agent needs; consult `CLAUDE.md` when you're going deep on a specific area.
