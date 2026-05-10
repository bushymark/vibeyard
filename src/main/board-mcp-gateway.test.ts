import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  createBoardSessionBinding,
  ensureProviderBoardMcpConfig,
  forwardBoardToolRequestForTesting,
  resolveBoardAgentResponseForTesting,
  resolveBoardSessionToken,
  resetBoardMcpGatewayForTesting,
} from './board-mcp-gateway';

vi.mock('electron', () => ({
  BrowserWindow: {},
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
}));

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

describe('board-mcp-gateway request forwarding', () => {
  it('forwards authenticated tool calls to renderer', async () => {
    const sent: unknown[] = [];
    const win = { webContents: { send: vi.fn((_channel, payload) => sent.push(payload)) } } as any;
    const token = createBoardSessionBinding('session-1');
    const promise = forwardBoardToolRequestForTesting(win, token, 'board_search_items', {});
    const request = sent[0] as { requestId: string };
    resolveBoardAgentResponseForTesting(request.requestId, { ok: true, result: [] });
    await expect(promise).resolves.toEqual({ ok: true, result: [] });
  });
});
