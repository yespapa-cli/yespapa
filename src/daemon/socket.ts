import { createServer, type Server, type Socket } from 'node:net';
import { existsSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import { createCommand, resolveCommand, type CommandStatus, type ApprovalSource } from '../db/index.js';
import { evaluateCommand } from '../rules/index.js';

export const SOCKET_PATH = '/tmp/yespapa.sock';

export interface CommandRequest {
  command: string;
  args: string[];
  fullCommand?: string;
  justification?: string;
}

export interface CommandResponse {
  status: 'approved' | 'denied' | 'timeout' | 'error';
  message?: string;
  id: string;
  command: string;
}

type ApprovalHandler = (
  commandId: string,
  command: string,
  args: string[],
  justification?: string,
) => Promise<{ status: CommandStatus; source?: ApprovalSource; message?: string }>;

function generateCommandId(): string {
  return `cmd_${randomBytes(4).toString('hex')}`;
}

export function createDaemonServer(
  db: Database.Database,
  onApprovalNeeded: ApprovalHandler,
): Server {
  const server = createServer((socket: Socket) => {
    let buffer = '';

    socket.on('data', (data) => {
      buffer += data.toString();

      // Process complete JSON messages (newline-delimited)
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (line.trim()) {
          handleRequest(db, socket, line.trim(), onApprovalNeeded);
        }
      }
    });

    socket.on('error', () => {
      // Client disconnected, ignore
    });
  });

  return server;
}

async function handleRequest(
  db: Database.Database,
  socket: Socket,
  data: string,
  onApprovalNeeded: ApprovalHandler,
): Promise<void> {
  let request: CommandRequest;
  try {
    request = JSON.parse(data);
  } catch {
    sendResponse(socket, { status: 'error', message: 'Invalid JSON', id: '', command: '' });
    return;
  }

  const { command, args, fullCommand, justification } = request;
  const commandId = generateCommandId();

  // Evaluate against rules
  const evalResult = evaluateCommand(command, args, fullCommand, db);

  if (evalResult.action === 'allow') {
    sendResponse(socket, { status: 'approved', id: commandId, command: fullCommand ?? [command, ...args].join(' ') });
    return;
  }

  if (evalResult.action === 'pass') {
    // Not on any rule list — pass through
    sendResponse(socket, { status: 'approved', id: commandId, command: fullCommand ?? [command, ...args].join(' ') });
    return;
  }

  // Command is denied by rules — needs approval
  const cmdStr = fullCommand ?? [command, ...args].join(' ');
  createCommand(db, commandId, cmdStr, justification);

  try {
    const result = await onApprovalNeeded(commandId, command, args, justification);

    resolveCommand(db, commandId, result.status, result.source, result.message);

    const response: CommandResponse = {
      status: result.status === 'approved' || result.status === 'grace' ? 'approved' : 'denied',
      message: result.message,
      id: commandId,
      command: cmdStr,
    };
    sendResponse(socket, response);
  } catch (err) {
    resolveCommand(db, commandId, 'timeout');
    sendResponse(socket, {
      status: 'timeout',
      message: 'Approval timed out',
      id: commandId,
      command: cmdStr,
    });
  }
}

function sendResponse(socket: Socket, response: CommandResponse): void {
  try {
    socket.write(JSON.stringify(response) + '\n');
  } catch {
    // Socket already closed
  }
}

export function startDaemonServer(
  db: Database.Database,
  onApprovalNeeded: ApprovalHandler,
  socketPath: string = SOCKET_PATH,
): Promise<Server> {
  // Clean up stale socket
  if (existsSync(socketPath)) {
    unlinkSync(socketPath);
  }

  const server = createDaemonServer(db, onApprovalNeeded);

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(socketPath, () => {
      resolve(server);
    });
  });
}

export function stopDaemonServer(server: Server, socketPath: string = SOCKET_PATH): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => {
      if (existsSync(socketPath)) {
        try { unlinkSync(socketPath); } catch { /* ignore */ }
      }
      resolve();
    });
  });
}
