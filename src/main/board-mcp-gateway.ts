import { BrowserWindow, ipcMain } from 'electron';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import type { ProviderId } from '../shared/types';

const SERVER_NAME = 'vibeyard-board';
const bindings = new Map<string, { sessionId: string }>();
const pending = new Map<string, (response: unknown) => void>();
let server: http.Server | null = null;
let port: number | null = null;
let ipcRegistered = false;

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

export function boardMcpServerScriptPath(): string {
  return path.join(__dirname, 'board-mcp-stdio.js');
}

export async function startBoardMcpGateway(win: BrowserWindow): Promise<number> {
  if (server && port) return port;
  registerIpcResponseHandler();
  server = http.createServer((req, res) => {
    void handleHttpRequest(win, req, res);
  });
  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject);
    server!.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('failed to bind board MCP gateway');
  port = address.port;
  return port;
}

export async function stopBoardMcpGateway(): Promise<void> {
  const current = server;
  server = null;
  port = null;
  bindings.clear();
  pending.clear();
  if (!current) return;
  await new Promise<void>((resolve, reject) => {
    current.close(err => err ? reject(err) : resolve());
  });
}

export async function forwardBoardToolRequest(
  win: BrowserWindow,
  sessionId: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const requestId = crypto.randomBytes(12).toString('hex');
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error(`board tool request timed out: ${tool}`));
    }, 15000);
    pending.set(requestId, (response) => {
      clearTimeout(timeout);
      resolve(response);
    });
    win.webContents.send('board:agentRequest', { requestId, sessionId, tool, args });
  });
}

export function ensureProviderBoardMcpConfig(providerId: ProviderId, projectPath: string, serverScriptPath: string): void {
  switch (providerId) {
    case 'claude':
      writeJsonMcpConfig(path.join(projectPath, '.mcp.json'), serverScriptPath);
      break;
    case 'copilot':
      writeJsonMcpConfig(path.join(projectPath, '.copilot', 'mcp-config.json'), serverScriptPath);
      break;
    case 'gemini':
      writeJsonMcpConfig(path.join(projectPath, '.gemini', 'settings.json'), serverScriptPath);
      break;
    case 'codex':
      writeCodexMcpConfig(path.join(projectPath, '.codex', 'config.toml'), serverScriptPath);
      break;
  }
}

export function resetBoardMcpGatewayForTesting(): void {
  bindings.clear();
  pending.clear();
  port = null;
  if (server) {
    server.close();
    server = null;
  }
}

export function forwardBoardToolRequestForTesting(
  win: BrowserWindow,
  token: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const binding = resolveBoardSessionToken(token);
  if (!binding) return Promise.resolve({ ok: false, error: { code: 'permission_denied', message: 'invalid board session token' } });
  return forwardBoardToolRequest(win, binding.sessionId, tool, args);
}

export function resolveBoardAgentResponseForTesting(requestId: string, response: unknown): void {
  resolveBoardAgentResponse(requestId, response);
}

async function handleHttpRequest(win: BrowserWindow, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (req.method !== 'POST' || req.url !== '/board-tool') {
    writeJson(res, 404, { ok: false, error: { code: 'not_found', message: 'not found' } });
    return;
  }
  try {
    const body = await readJsonBody(req);
    const token = typeof body.token === 'string' ? body.token : '';
    const binding = resolveBoardSessionToken(token);
    if (!binding) {
      writeJson(res, 403, { ok: false, error: { code: 'permission_denied', message: 'invalid board session token' } });
      return;
    }
    const tool = typeof body.tool === 'string' ? body.tool : '';
    const args = isRecord(body.args) ? body.args : {};
    const response = await forwardBoardToolRequest(win, binding.sessionId, tool, args);
    writeJson(res, 200, response);
  } catch (error) {
    writeJson(res, 400, { ok: false, error: { code: 'bad_request', message: error instanceof Error ? error.message : 'bad request' } });
  }
}

function registerIpcResponseHandler(): void {
  if (ipcRegistered) return;
  ipcMain.on('board:agentResponse', (_event, requestId: string, response: unknown) => {
    resolveBoardAgentResponse(requestId, response);
  });
  ipcRegistered = true;
}

function resolveBoardAgentResponse(requestId: string, response: unknown): void {
  const resolve = pending.get(requestId);
  if (!resolve) return;
  pending.delete(requestId);
  resolve(response);
}

function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 1024 * 1024) {
        reject(new Error('request too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(raw || '{}');
        resolve(isRecord(parsed) ? parsed : {});
      } catch {
        reject(new Error('invalid json'));
      }
    });
    req.on('error', reject);
  });
}

function writeJson(res: http.ServerResponse, statusCode: number, payload: unknown): void {
  res.writeHead(statusCode, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function writeJsonMcpConfig(filePath: string, serverScriptPath: string): void {
  const existing = readJsonFile(filePath);
  const next = {
    ...existing,
    mcpServers: {
      ...(isRecord(existing.mcpServers) ? existing.mcpServers : {}),
      [SERVER_NAME]: {
        command: 'node',
        args: [serverScriptPath],
      },
    },
  };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(next, null, 2)}\n`);
}

function writeCodexMcpConfig(filePath: string, serverScriptPath: string): void {
  const block = [
    `[mcp_servers.${SERVER_NAME}]`,
    `command = "node"`,
    `args = [${JSON.stringify(serverScriptPath)}]`,
  ].join('\n');
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  const replaced = existing.replace(
    new RegExp(`\\n?\\[mcp_servers\\.${escapeRegExp(SERVER_NAME)}\\]\\n(?:[^\\[]|\\[(?!mcp_servers\\.))*`, 'm'),
    '\n',
  ).trim();
  const next = `${replaced ? `${replaced}\n\n` : ''}${block}\n`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, next);
}

function readJsonFile(filePath: string): Record<string, unknown> {
  if (!fs.existsSync(filePath)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
