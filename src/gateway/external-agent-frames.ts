/**
 * External Agent Frame Handlers
 *
 * Handles response and event frames from external agent backends (IDE, CLI).
 * Extracted from message-handler.ts for cleaner separation.
 */

import { handleExternalAgentResponse, notifyExternalAgentStream } from "./external-agent-router.js";
import { GATEWAY_CLIENT_MODES } from "./protocol/client-info.js";
import type { GatewayRequestContext } from "./server-methods/types.js";

type LogWsFn = (dir: "in" | "out", type: string, meta: Record<string, unknown>) => void;

type GetClientFn = () =>
  | {
      connect?: {
        client: { mode?: string };
      };
    }
  | null
  | undefined;

export interface ExternalAgentFrameResult {
  handled: boolean;
}

/**
 * Try to handle a frame as an external agent frame (response or event).
 * Returns { handled: true } if the frame was processed, { handled: false } otherwise.
 */
export function tryHandleExternalAgentFrame(
  parsed: unknown,
  connId: string,
  getClient: GetClientFn,
  buildRequestContext: () => Pick<GatewayRequestContext, "broadcast">,
  logWs: LogWsFn,
): ExternalAgentFrameResult {
  const frameType = (parsed as { type?: string })?.type;

  if (frameType === "res") {
    const resFrame = parsed as {
      id: string;
      ok: boolean;
      payload?: unknown;
      error?: { code?: string; message?: string };
    };
    return handleResponseFrame(resFrame, connId, logWs);
  }

  if (frameType === "event") {
    const evtFrame = parsed as { event: string; payload?: unknown };
    return handleEventFrame(evtFrame, connId, getClient, buildRequestContext, logWs);
  }

  return { handled: false };
}

/**
 * Handle response frames from agent-backend clients
 */
function handleResponseFrame(
  frame: {
    id: string;
    ok: boolean;
    payload?: unknown;
    error?: { code?: string; message?: string };
  },
  connId: string,
  logWs: LogWsFn,
): ExternalAgentFrameResult {
  if (handleExternalAgentResponse(frame.id, frame.ok, frame.payload, frame.error, connId)) {
    logWs("in", "res", { connId, id: frame.id, ok: frame.ok });
  } else {
    logWs("in", "res-ignored", { connId, id: frame.id, reason: "no pending request" });
  }
  return { handled: true };
}

/**
 * Handle event frames from agent-backend clients (streaming)
 */
function handleEventFrame(
  frame: { event: string; payload?: unknown },
  connId: string,
  getClient: GetClientFn,
  buildRequestContext: () => Pick<GatewayRequestContext, "broadcast">,
  logWs: LogWsFn,
): ExternalAgentFrameResult {
  const client = getClient();
  const isAgentBackend = client?.connect?.client.mode === GATEWAY_CLIENT_MODES.AGENT_BACKEND;

  if (!isAgentBackend) {
    logWs("in", "event-rejected", { connId, reason: "not-agent-backend" });
    return { handled: true };
  }

  if (frame.event === "agent.stream") {
    handleAgentStreamEvent(frame.payload, connId, buildRequestContext, logWs);
  } else {
    // Forward other events as-is
    const context = buildRequestContext();
    context.broadcast(frame.event, frame.payload, { dropIfSlow: true });
    logWs("in", "event", { connId, event: frame.event });
  }

  return { handled: true };
}

/**
 * Handle agent.stream events - forward to chat/agent broadcasts
 */
function handleAgentStreamEvent(
  payload: unknown,
  connId: string,
  buildRequestContext: () => Pick<GatewayRequestContext, "broadcast">,
  logWs: LogWsFn,
): void {
  const p = payload as
    | {
        runId?: string;
        agentId?: string;
        sessionKey?: string;
        state?: string;
        text?: string;
        toolName?: string;
        toolState?: string;
        message?: string;
      }
    | undefined;

  // Notify stream listener (for channel dispatch, e.g., Telegram block streaming).
  if (p?.runId && p?.state) {
    notifyExternalAgentStream(p.runId, {
      state: p.state as "delta" | "tool" | "thinking" | "progress" | "error" | "done",
      text: p.text,
      toolName: p.toolName,
      toolState: p.toolState as "start" | "end" | undefined,
      message: p.message,
    });
  }

  if (p?.state === "delta" && typeof p.text === "string") {
    // Broadcast as chat delta
    const context = buildRequestContext();
    context.broadcast(
      "chat",
      {
        runId: p.runId,
        sessionKey: p.sessionKey,
        state: "delta",
        message: {
          role: "assistant",
          content: [{ type: "text", text: p.text }],
          timestamp: Date.now(),
        },
      },
      { dropIfSlow: true },
    );
  } else if (p?.state === "tool") {
    // Broadcast tool events
    const context = buildRequestContext();
    context.broadcast(
      "agent",
      {
        runId: p.runId,
        sessionKey: p.sessionKey,
        stream: "tool",
        data: {
          name: p.toolName,
          state: p.toolState,
        },
        ts: Date.now(),
      },
      { dropIfSlow: true },
    );
  }

  logWs("in", "event", { connId, event: "agent.stream", state: p?.state });
}
