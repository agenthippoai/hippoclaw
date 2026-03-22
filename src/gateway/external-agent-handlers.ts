/**
 * External Agent Method Handlers
 *
 * Handlers for agents.register, agents.unregister, and routing helpers
 * for agent/chat methods to route to external agents.
 */

import { loadConfig } from "../config/config.js";
import { listBindings } from "../routing/bindings.js";
import {
  registerExternalAgent,
  unregisterExternalAgent,
  listExternalAgents,
} from "./external-agent-registry.js";
import {
  isExternalAgent,
  routeToExternalAgent,
  requestNewSessionFromExternalAgent,
} from "./external-agent-router.js";
import { GATEWAY_CLIENT_MODES } from "./protocol/client-info.js";
import { ErrorCodes, errorShape } from "./protocol/index.js";
import type { GatewayRequestHandlers } from "./server-methods/types.js";

/**
 * Handlers for agents.register and agents.unregister
 */
export const externalAgentMethodHandlers: GatewayRequestHandlers = {
  /**
   * Register an external agent (from IDE, CLI, etc.)
   * Only available for clients in agent-backend mode.
   */
  "agents.register": ({ params, client, respond, context }) => {
    const p = params as {
      agent?: {
        id?: string;
        name?: string;
        workspace?: string;
        capabilities?: string[];
      };
    };

    if (!client) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "agents.register requires authenticated client"),
      );
      return;
    }

    if (client.connect?.client?.mode !== GATEWAY_CLIENT_MODES.AGENT_BACKEND) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "agents.register requires agent-backend client mode",
        ),
      );
      return;
    }

    const agent = p.agent;
    if (!agent?.id || typeof agent.id !== "string" || !agent.id.trim()) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "agents.register requires agent.id"),
      );
      return;
    }

    const connId = client.connId?.trim();
    if (!connId) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "agents.register requires connection id"),
      );
      return;
    }
    const agentId = agent.id.trim();

    const wsClient = client as import("./server/ws-types.js").GatewayWsClient;
    registerExternalAgent(connId, wsClient, {
      id: agentId,
      name: agent.name,
      workspace: agent.workspace,
      capabilities: agent.capabilities,
    });

    context.logGateway.info(`external agent registered: ${agentId} (conn=${connId})`);
    context.broadcast("agents.updated", { action: "register", agentId }, { dropIfSlow: true });

    // Check if this agent has any channel bindings configured.
    const cfg = loadConfig();
    const agentBindings = listBindings(cfg).filter(
      (b) => b.agentId.toLowerCase() === agentId.toLowerCase(),
    );
    const boundChannels = agentBindings.map((b) => b.match.channel);
    const needsBinding = agentBindings.length === 0;

    respond(true, { agentId, needsBinding, boundChannels }, undefined);
  },

  /**
   * Unregister an external agent.
   */
  "agents.unregister": ({ params, client, respond, context }) => {
    const p = params as { agentId?: string };

    if (!client) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "agents.unregister requires authenticated client"),
      );
      return;
    }

    if (client.connect?.client?.mode !== GATEWAY_CLIENT_MODES.AGENT_BACKEND) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "agents.unregister requires agent-backend client mode",
        ),
      );
      return;
    }

    if (!p.agentId || typeof p.agentId !== "string" || !p.agentId.trim()) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "agents.unregister requires agentId"),
      );
      return;
    }

    const connId = client.connId?.trim();
    if (!connId) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "agents.unregister requires connection id"),
      );
      return;
    }
    const agentId = p.agentId.trim();
    const removed = unregisterExternalAgent(connId, agentId);

    if (!removed) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `agent ${agentId} not found or not owned by this connection`,
        ),
      );
      return;
    }

    context.logGateway.info(`external agent unregistered: ${agentId} (conn=${connId})`);
    context.broadcast("agents.updated", { action: "unregister", agentId }, { dropIfSlow: true });

    respond(true, { agentId }, undefined);
  },
};

/**
 * Get external agents formatted for agents.list response
 */
export function getExternalAgentsForList(): Array<{
  id: string;
  name?: string;
  workspace?: string;
  external: true;
  connId: string;
  boundChannels: string[];
}> {
  const cfg = loadConfig();
  const bindings = listBindings(cfg);
  return listExternalAgents().map((reg) => {
    const agentBindings = bindings.filter(
      (b) => b.agentId.toLowerCase() === reg.agentId.toLowerCase(),
    );
    return {
      id: reg.agentId,
      name: reg.name,
      workspace: reg.workspace,
      external: true as const,
      connId: reg.connId,
      boundChannels: agentBindings.map((b) => b.match.channel),
    };
  });
}

// Re-export for convenience
export { isExternalAgent, routeToExternalAgent, requestNewSessionFromExternalAgent };

/**
 * Request a new session from an external agent.
 * This can be called from the web UI to ask the IDE to create a new chat session.
 *
 * @param agentId - The agent ID or pattern (e.g., "ide-*" for any IDE agent)
 * @param requestedBy - Who is requesting the new session (e.g., "webchat")
 * @param initialMessage - Optional initial message to send after session is created
 */
export async function requestNewExternalSession(
  agentId: string,
  requestedBy: string,
  initialMessage?: string,
  sessionKey?: string,
): Promise<{ success: boolean; agentId?: string; error?: string }> {
  // If agentId contains a wildcard, find any matching external agent
  let targetAgentId = agentId;
  if (agentId.includes("*")) {
    const pattern = new RegExp(`^${agentId.replace(/\*/g, ".*")}$`);
    const agents = listExternalAgents();
    const matchingAgent = agents.find((a) => pattern.test(a.agentId));
    if (!matchingAgent) {
      return { success: false, error: `No external agent matching pattern: ${agentId}` };
    }
    targetAgentId = matchingAgent.agentId;
  }

  if (!isExternalAgent(targetAgentId)) {
    return { success: false, error: `Agent ${targetAgentId} is not an external agent` };
  }

  try {
    const result = await requestNewSessionFromExternalAgent(targetAgentId, {
      agentPattern: agentId,
      requestedBy,
      initialMessage,
      sessionKey,
    });
    return result;
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

/**
 * Route to external agent for the "agent" method.
 * Returns true if routing was initiated (caller should return early).
 */
export function tryRouteAgentMethodToExternal<TErrorCode>(opts: {
  agentId: string;
  message: string;
  sessionKey?: string;
  sessionId?: string;
  channel?: string;
  idempotencyKey: string;
  runId: string;
  context: {
    logGateway: { debug: (msg: string) => void };
    dedupe: Map<string, unknown>;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  respond: (ok: boolean, payload: unknown, error: any, meta?: { runId?: string }) => void;
  errorShape: (code: TErrorCode, msg: string) => unknown;
  errorCode: TErrorCode;
}): boolean {
  if (!isExternalAgent(opts.agentId)) {
    return false;
  }

  opts.context.logGateway.debug(`agent handler: routing to external agent ${opts.agentId}`);

  void routeToExternalAgent(opts.agentId, {
    message: opts.message,
    agentId: opts.agentId,
    sessionKey: opts.sessionKey,
    sessionId: opts.sessionId,
    channel: opts.channel,
    idempotencyKey: opts.idempotencyKey,
  })
    .then((result) => {
      opts.context.logGateway.debug(
        `agent handler: external agent ${opts.agentId} returned text.length=${result.text?.length ?? 0}`,
      );
      const payload = {
        runId: opts.runId,
        status: "ok" as const,
        summary: "completed",
        result: {
          payloads: [{ text: result.text }],
        },
      };
      opts.context.dedupe.set(`agent:${opts.idempotencyKey}`, {
        ts: Date.now(),
        ok: true,
        payload,
      });
      opts.respond(true, payload, undefined, { runId: opts.runId });
    })
    .catch((err) => {
      const error = opts.errorShape(opts.errorCode, String(err));
      const payload = {
        runId: opts.runId,
        status: "error" as const,
        summary: String(err),
      };
      opts.context.dedupe.set(`agent:${opts.idempotencyKey}`, {
        ts: Date.now(),
        ok: false,
        payload,
        error,
      });
      opts.respond(false, payload, error, { runId: opts.runId });
    });

  return true;
}

/**
 * Route to external agent for the "chat.send" method.
 * Returns true if routing was initiated (caller should return early).
 */
export function tryRouteChatToExternal<TContext, TErrorCode>(opts: {
  agentId: string;
  message: string;
  sessionKey: string;
  sessionId?: string;
  channel: string;
  clientRunId: string;
  context: TContext & {
    logGateway: { debug: (msg: string) => void };
    dedupe: Map<string, unknown>;
    chatAbortControllers: Map<string, unknown>;
  };
  broadcastFinal: (opts: {
    context: TContext;
    runId: string;
    sessionKey: string;
    message?: Record<string, unknown>;
  }) => void;
  broadcastError: (opts: {
    context: TContext;
    runId: string;
    sessionKey: string;
    errorMessage: string;
  }) => void;
  buildFinalMessage?: (replyText: string) => Record<string, unknown> | undefined;
  errorShape: (code: TErrorCode, msg: string) => unknown;
  errorCode: TErrorCode;
}): boolean {
  if (!isExternalAgent(opts.agentId)) {
    return false;
  }

  void routeToExternalAgent(opts.agentId, {
    message: opts.message,
    agentId: opts.agentId,
    sessionKey: opts.sessionKey,
    sessionId: opts.sessionId,
    channel: opts.channel,
    idempotencyKey: opts.clientRunId,
  })
    .then((result) => {
      opts.context.logGateway.debug(
        `chat.send: external agent ${opts.agentId} returned text.length=${result.text?.length ?? 0}`,
      );
      const combinedReply = result.text?.trim() ?? "";
      const now = Date.now();
      const message =
        opts.buildFinalMessage?.(combinedReply) ??
        (combinedReply
          ? {
              role: "assistant",
              content: [{ type: "text", text: combinedReply }],
              timestamp: now,
            }
          : undefined);
      opts.broadcastFinal({
        context: opts.context,
        runId: opts.clientRunId,
        sessionKey: opts.sessionKey,
        message,
      });
      opts.context.dedupe.set(`chat:${opts.clientRunId}`, {
        ts: Date.now(),
        ok: true,
        payload: { runId: opts.clientRunId, status: "ok" as const },
      });
    })
    .catch((err) => {
      const error = opts.errorShape(opts.errorCode, String(err));
      opts.context.dedupe.set(`chat:${opts.clientRunId}`, {
        ts: Date.now(),
        ok: false,
        payload: {
          runId: opts.clientRunId,
          status: "error" as const,
          summary: String(err),
        },
        error,
      });
      opts.broadcastError({
        context: opts.context,
        runId: opts.clientRunId,
        sessionKey: opts.sessionKey,
        errorMessage: String(err),
      });
    })
    .finally(() => {
      opts.context.chatAbortControllers.delete(opts.clientRunId);
    });

  return true;
}
