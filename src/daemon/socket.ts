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
  status: 'approved' | 'denied' | 'timeout' | 'error' | 'needs_totp' | 'pending';
  message?: string;
  id: string;
  command: string;
  rule?: string;
}

/**
 * A TOTP submission from the interceptor: { totp: "123456", id: "cmd_xxx" }
 */
export interface TotpSubmission {
  totp: string;
  id: string;
}

/**
 * A poll-check from the interceptor: { check: "cmd_xxx" }
 * Used to poll for remote resolution (Supabase approval/denial).
 */
export interface PollCheck {
  check: string;
}

export interface RemoteResolution {
  status: 'approved' | 'denied';
  message?: string;
  source: 'app_approve';
}

export type TotpValidator = (code: string) => boolean;
export type GraceChecker = (bundle?: string) => boolean;

// Track remotely resolved commands (set by sync module when Supabase approval arrives)
const remoteResolutions = new Map<string, RemoteResolution>();

/**
 * Record a remote resolution (called by sync module when Supabase approval/denial arrives).
 */
export function setRemoteResolution(commandId: string, resolution: RemoteResolution): void {
  remoteResolutions.set(commandId, resolution);
}

/**
 * Get pending commands map (for sync module to know what's pending).
 */
export function getPendingCommandIds(): string[] {
  return [...pendingCommandsRef.keys()];
}

// Module-level reference to pending commands map (set in createDaemonServer)
let pendingCommandsRef = new Map<string, { command: string; bundle?: string }>();

function generateCommandId(): string {
  return `cmd_${randomBytes(4).toString('hex')}`;
}

/**
 * Create the daemon socket server.
 *
 * Protocol (two-phase for denied commands):
 * 1. Interceptor sends CommandRequest → daemon replies with 'approved', 'error', or 'needs_totp'
 * 2. If 'needs_totp': interceptor prompts user, sends TotpSubmission → daemon replies 'approved' or 'denied'
 */
export function createDaemonServer(
  db: Database.Database,
  validateTotp: TotpValidator,
  checkGrace: GraceChecker,
): Server {
  // Track pending commands waiting for TOTP
  const pendingCommands = new Map<string, { command: string; bundle?: string }>();
  pendingCommandsRef = pendingCommands;

  const server = createServer((socket: Socket) => {
    let buffer = '';

    socket.on('data', (data) => {
      buffer += data.toString();

      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (line.trim()) {
          handleMessage(db, socket, line.trim(), validateTotp, checkGrace, pendingCommands);
        }
      }
    });

    socket.on('error', () => {});
  });

  return server;
}

function handleMessage(
  db: Database.Database,
  socket: Socket,
  data: string,
  validateTotp: TotpValidator,
  checkGrace: GraceChecker,
  pendingCommands: Map<string, { command: string; bundle?: string }>,
): void {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(data);
  } catch {
    sendResponse(socket, { status: 'error', message: 'Invalid JSON', id: '', command: '' });
    return;
  }

  // Poll-check: interceptor asking if a command was resolved remotely
  if ('check' in msg) {
    const checkId = msg.check as string;
    const resolution = remoteResolutions.get(checkId);
    if (resolution) {
      const pending = pendingCommands.get(checkId);
      remoteResolutions.delete(checkId);
      pendingCommands.delete(checkId);
      resolveCommand(db, checkId, resolution.status as CommandStatus, resolution.source as ApprovalSource, resolution.message);
      sendResponse(socket, {
        status: resolution.status,
        id: checkId,
        command: pending?.command ?? '',
        message: resolution.message,
      });
    } else {
      sendResponse(socket, { status: 'pending', id: checkId, command: '' });
    }
    return;
  }

  // Phase 2: TOTP submission for a pending command
  if ('totp' in msg && 'id' in msg) {
    const submission = msg as unknown as TotpSubmission;
    const pending = pendingCommands.get(submission.id);
    if (!pending) {
      sendResponse(socket, { status: 'error', message: 'Unknown command ID', id: submission.id, command: '' });
      return;
    }

    if (validateTotp(submission.totp)) {
      pendingCommands.delete(submission.id);
      resolveCommand(db, submission.id, 'approved', 'totp_stdin');
      sendResponse(socket, { status: 'approved', id: submission.id, command: pending.command });
    } else {
      sendResponse(socket, { status: 'denied', message: 'Invalid TOTP code', id: submission.id, command: pending.command });
    }
    return;
  }

  // Phase 1: Command request
  const request = msg as unknown as CommandRequest;
  const { command, args, fullCommand, justification } = request;
  const commandId = generateCommandId();
  const cmdStr = fullCommand ?? [command, ...args].join(' ');

  // Evaluate against rules
  const evalResult = evaluateCommand(command, args, fullCommand, db);

  if (evalResult.action === 'allow' || evalResult.action === 'pass') {
    sendResponse(socket, { status: 'approved', id: commandId, command: cmdStr });
    return;
  }

  // Check grace periods
  const bundle = evalResult.rule?.bundle ?? undefined;
  if (checkGrace(bundle)) {
    createCommand(db, commandId, cmdStr, justification);
    resolveCommand(db, commandId, 'grace', 'grace_token');
    sendResponse(socket, { status: 'approved', id: commandId, command: cmdStr, message: 'Grace period active' });
    return;
  }

  // Needs TOTP — log command and ask interceptor to prompt user
  createCommand(db, commandId, cmdStr, justification);
  pendingCommands.set(commandId, { command: cmdStr, bundle });
  sendResponse(socket, {
    status: 'needs_totp',
    id: commandId,
    command: cmdStr,
    rule: evalResult.rule?.reason ?? undefined,
  });
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
  validateTotp: TotpValidator,
  checkGrace: GraceChecker,
  socketPath: string = SOCKET_PATH,
): Promise<Server> {
  // Clean up stale socket
  if (existsSync(socketPath)) {
    unlinkSync(socketPath);
  }

  const server = createDaemonServer(db, validateTotp, checkGrace);

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
