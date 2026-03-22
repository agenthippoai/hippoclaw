/**
 * External Agent Router
 *
 * Routes agent.run requests to external agent backends via WebSocket.
 */

import { getExternalAgent } from "./external-agent-registry.js";

export { isIdeGatewayExternalAgentId } from "../routing/session-key.js";

// Track pending requests - generic to support different result types
interface PendingRequest<T = unknown> {
  resolve: (result: T) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
  connId: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pendingRequests = new Map<string, PendingRequest<any>>();
let requestIdCounter = 0;

/**
 * Stream event from an external agent (IDE).
 * Matches the agent.stream event payload shape.
 */
export interface ExternalAgentStreamEvent {
  state: "delta" | "tool" | "thinking" | "progress" | "error" | "done";
  text?: string;
  toolName?: string;
  toolState?: "start" | "end";
  message?: string;
}

/** Stream listeners keyed by idempotencyKey (= runId in stream events). */
const streamListeners = new Map<string, (event: ExternalAgentStreamEvent) => void>();

/** Maps sessionKey → requestId for active external agent runs, enabling abort by session. */
const activeSessionRuns = new Map<string, string>();

/**
 * Secondary index: maps canonical peer key → { sessionKey, agentId }.
 * Peer key format: "{channel}:{senderId}" (e.g., "telegram:8502648932").
 * Used when abort messages have a different sessionKey format than regular messages
 * (e.g., Telegram /stop uses "telegram:slash:PEERID" instead of "agent:...:dm:PEERID").
 */
const activeRunsByPeer = new Map<string, { sessionKey: string; agentId: string }>();

/** Build a canonical peer key from channel + senderId. */
function buildPeerKey(channel?: string, senderId?: string): string | undefined {
  const ch = channel?.trim().toLowerCase();
  const id = senderId?.trim();
  if (!ch || !id) {
    return undefined;
  }
  return `${ch}:${id}`;
}

/**
 * Notify a stream event for an external agent run.
 * Called by the gateway frame handler when an agent.stream event arrives.
 * Returns true if a listener was found and notified.
 */
export function notifyExternalAgentStream(runId: string, event: ExternalAgentStreamEvent): boolean {
  const listener = streamListeners.get(runId);
  if (!listener) {
    return false;
  }
  listener(event);
  return true;
}

/**
 * Cancel an active external agent run for a given sessionKey.
 * Rejects the pending promise and sends agent.cancel to the IDE.
 * Returns true if a pending run was found and cancelled.
 */
export function cancelExternalAgentRun(sessionKey: string): boolean {
  const requestId = activeSessionRuns.get(sessionKey);
  if (!requestId) {
    return false;
  }
  const pending = pendingRequests.get(requestId);
  if (!pending) {
    activeSessionRuns.delete(sessionKey);
    return false;
  }
  pending.reject(new Error("Agent run cancelled by user"));
  return true;
}

/**
 * Cancel an active external agent run by canonical peer key (exact match).
 * Peer key format: "{channel}:{senderId}" (e.g., "telegram:8502648932").
 * Returns the matching sessionKey and agentId if found.
 */
export function cancelExternalAgentRunByPeerKey(
  channel?: string,
  senderId?: string,
): { sessionKey: string; agentId: string } | null {
  const peerKey = buildPeerKey(channel, senderId);
  if (!peerKey) {
    return null;
  }
  const entry = activeRunsByPeer.get(peerKey);
  if (!entry) {
    return null;
  }
  const cancelled = cancelExternalAgentRun(entry.sessionKey);
  if (cancelled) {
    activeRunsByPeer.delete(peerKey);
    return entry;
  }
  return null;
}

/**
 * Send agent.cancel to an external agent backend (fire-and-forget).
 * This tells the IDE to stop the current generation.
 */
export function sendCancelToExternalAgent(agentId: string, sessionKey?: string): void {
  const registration = getExternalAgent(agentId);
  if (!registration) {
    return;
  }
  const { client } = registration;
  if (!client?.socket) {
    return;
  }
  const cancelId = `cancel-${++requestIdCounter}-${Date.now()}`;
  try {
    client.socket.send(
      JSON.stringify({
        type: "req",
        id: cancelId,
        method: "agent.cancel",
        params: { agentId, sessionKey },
      }),
    );
  } catch {
    // Best-effort cancel.
  }
}

export interface MediaAttachment {
  type: "image" | "audio" | "video" | "document";
  url?: string;
  path?: string;
  mimeType?: string;
  fileName?: string;
}

export interface AgentRunRequest {
  message: string;
  agentId: string;
  sessionKey?: string;
  sessionId?: string;
  channel?: string;
  /** Sender identity (username, e.g., "@trungn" on Telegram) */
  senderUsername?: string;
  /** Sender display name */
  senderName?: string;
  /** Sender platform-specific ID */
  senderId?: string;
  /** Media attachments (images, audio, video, documents) */
  attachments?: MediaAttachment[];
  idempotencyKey: string;
}

export interface AgentRunResult {
  text: string;
  runId?: string;
}

/**
 * Check if an agent is an external agent
 */
export function isExternalAgent(agentId: string): boolean {
  return getExternalAgent(agentId) !== undefined;
}

/**
 * Route an agent.run request to an external backend.
 * Optionally accepts an onStream callback to receive partial results as they arrive.
 */
export async function routeToExternalAgent(
  agentId: string,
  request: AgentRunRequest,
  opts?: {
    timeoutMs?: number;
    onStream?: (event: ExternalAgentStreamEvent) => void;
  },
): Promise<AgentRunResult> {
  const timeoutMs = opts?.timeoutMs ?? 300000;
  const registration = getExternalAgent(agentId);
  if (!registration) {
    throw new Error(`External agent ${agentId} not found`);
  }

  const { client } = registration;
  if (!client?.socket) {
    throw new Error(`Connection for agent ${agentId} not available`);
  }

  const requestId = `ext-${++requestIdCounter}-${Date.now()}`;

  // Register stream listener if callback provided.
  // Stream events use idempotencyKey as runId.
  if (opts?.onStream) {
    streamListeners.set(request.idempotencyKey, opts.onStream);
  }

  // Track active run by sessionKey + peer key for abort support.
  if (request.sessionKey) {
    activeSessionRuns.set(request.sessionKey, requestId);
  }
  const peerKey = buildPeerKey(request.channel, request.senderId);
  if (peerKey && request.sessionKey) {
    activeRunsByPeer.set(peerKey, { sessionKey: request.sessionKey, agentId: request.agentId });
  }

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      pendingRequests.delete(requestId);
      streamListeners.delete(request.idempotencyKey);
      if (request.sessionKey) {
        activeSessionRuns.delete(request.sessionKey);
      }
      if (peerKey) {
        activeRunsByPeer.delete(peerKey);
      }
    };

    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`External agent ${agentId} timed out`));
    }, timeoutMs);

    pendingRequests.set(requestId, {
      resolve: (result: AgentRunResult) => {
        clearTimeout(timeout);
        cleanup();
        resolve(result);
      },
      reject: (err: Error) => {
        clearTimeout(timeout);
        cleanup();
        reject(err);
      },
      timeout,
      connId: registration.connId,
    });

    try {
      client.socket.send(
        JSON.stringify({
          type: "req",
          id: requestId,
          method: "agent.run",
          params: {
            message: request.message,
            agentId: request.agentId,
            sessionKey: request.sessionKey,
            sessionId: request.sessionId,
            channel: request.channel,
            senderUsername: request.senderUsername,
            senderName: request.senderName,
            senderId: request.senderId,
            attachments: request.attachments,
            idempotencyKey: request.idempotencyKey,
          },
        }),
      );
    } catch (err) {
      cleanup();
      reject(err);
    }
  });
}

/**
 * Handle response from external agent backend
 */
export function handleExternalAgentResponse(
  requestId: string,
  ok: boolean,
  payload?: unknown,
  error?: { code?: string; message?: string },
  connId?: string,
): boolean {
  const pending = pendingRequests.get(requestId);
  if (!pending) {
    return false;
  }
  if (connId && pending.connId !== connId) {
    return false;
  }

  if (ok && payload) {
    pending.resolve(payload as AgentRunResult);
  } else {
    pending.reject(new Error(error?.message || "External agent failed"));
  }

  return true;
}

/**
 * Parameters for session.new request
 */
export interface SessionNewRequest {
  /** Pattern to match agent IDs (e.g., "ide-*" for all IDE agents) */
  agentPattern?: string;
  /** Who requested the new session (e.g., "webchat", "telegram") */
  requestedBy?: string;
  /** Optional initial message to send after session is created */
  initialMessage?: string;
  /** Gateway session key (so IDE can update its session map) */
  sessionKey?: string;
}

/**
 * Result of session.new request
 */
export interface SessionNewResult {
  success: boolean;
  agentId?: string;
  error?: string;
}

/**
 * Send a session.new request to an external agent backend.
 * This requests the IDE to create a new chat session.
 */
export async function requestNewSessionFromExternalAgent(
  agentId: string,
  request: SessionNewRequest,
  timeoutMs = 30000, // 30 seconds default for session creation
): Promise<SessionNewResult> {
  const registration = getExternalAgent(agentId);
  if (!registration) {
    throw new Error(`External agent ${agentId} not found`);
  }

  const { client } = registration;
  if (!client?.socket) {
    throw new Error(`Connection for agent ${agentId} not available`);
  }

  const requestId = `session-new-${++requestIdCounter}-${Date.now()}`;

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new Error(`Session.new request to agent ${agentId} timed out`));
    }, timeoutMs);

    pendingRequests.set(requestId, {
      resolve: (result) => resolve(result as SessionNewResult),
      reject,
      timeout,
      connId: registration.connId,
    });

    try {
      client.socket.send(
        JSON.stringify({
          type: "req",
          id: requestId,
          method: "session.new",
          params: {
            agentPattern: request.agentPattern ?? agentId,
            requestedBy: request.requestedBy,
            initialMessage: request.initialMessage,
            sessionKey: request.sessionKey,
          },
        }),
      );
    } catch (err) {
      clearTimeout(timeout);
      pendingRequests.delete(requestId);
      reject(err);
    }
  });
}

/** For testing only */
export function __resetExternalAgentRouterForTest(): void {
  for (const pending of pendingRequests.values()) {
    clearTimeout(pending.timeout);
  }
  pendingRequests.clear();
  streamListeners.clear();
  activeSessionRuns.clear();
  activeRunsByPeer.clear();
  requestIdCounter = 0;
}
