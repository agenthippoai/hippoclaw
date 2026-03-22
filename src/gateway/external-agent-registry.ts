/**
 * External Agent Registry
 *
 * Manages agents registered by external backends (IDE, CLI) via WebSocket.
 * These agents handle `agent.run` requests instead of the built-in Pi agent.
 *
 * Uses a module-level singleton for simplicity.
 */

import type { GatewayWsClient } from "./server/ws-types.js";

export type ExternalAgentRegistration = {
  agentId: string;
  connId: string;
  client: GatewayWsClient;
  name?: string;
  workspace?: string;
  capabilities?: string[];
  registeredAt: number;
};

const agents = new Map<string, ExternalAgentRegistration>();
const connToAgents = new Map<string, Set<string>>();

export function registerExternalAgent(
  connId: string,
  client: GatewayWsClient,
  agent: { id: string; name?: string; workspace?: string; capabilities?: string[] },
): void {
  const previous = agents.get(agent.id);
  if (previous) {
    const previousAgents = connToAgents.get(previous.connId);
    previousAgents?.delete(agent.id);
    if (previousAgents && previousAgents.size === 0) {
      connToAgents.delete(previous.connId);
    }
  }
  const registration: ExternalAgentRegistration = {
    agentId: agent.id,
    connId,
    client,
    name: agent.name,
    workspace: agent.workspace,
    capabilities: agent.capabilities,
    registeredAt: Date.now(),
  };
  agents.set(agent.id, registration);

  let connAgents = connToAgents.get(connId);
  if (!connAgents) {
    connAgents = new Set();
    connToAgents.set(connId, connAgents);
  }
  connAgents.add(agent.id);
}

export function unregisterExternalAgent(connId: string, agentId: string): boolean {
  const reg = agents.get(agentId);
  if (!reg || reg.connId !== connId) {
    return false;
  }
  agents.delete(agentId);
  connToAgents.get(connId)?.delete(agentId);
  return true;
}

export function unregisterAllExternalAgents(connId: string): string[] {
  const agentIds = connToAgents.get(connId);
  if (!agentIds) {
    return [];
  }
  const removed: string[] = [];
  for (const agentId of agentIds) {
    const current = agents.get(agentId);
    if (current?.connId !== connId) {
      continue;
    }
    agents.delete(agentId);
    removed.push(agentId);
  }
  connToAgents.delete(connId);
  return removed;
}

type CleanupContext = {
  logInfo: (msg: string) => void;
  broadcast: (event: string, payload: unknown, opts?: { dropIfSlow?: boolean }) => void;
};

/**
 * Cleanup external agents on connection disconnect.
 * Logs and broadcasts the cleanup event.
 */
export function cleanupExternalAgentsOnDisconnect(connId: string, context: CleanupContext): void {
  const removedAgents = unregisterAllExternalAgents(connId);
  if (removedAgents.length > 0) {
    context.logInfo(
      `external agents cleaned up on disconnect: ${removedAgents.join(", ")} (conn=${connId})`,
    );
    context.broadcast(
      "agents.updated",
      { action: "disconnect", agentIds: removedAgents },
      { dropIfSlow: true },
    );
  }
}

export function getExternalAgent(agentId: string): ExternalAgentRegistration | undefined {
  return agents.get(agentId);
}

export function hasExternalAgent(agentId: string): boolean {
  return agents.has(agentId);
}

export function listExternalAgents(): ExternalAgentRegistration[] {
  return Array.from(agents.values());
}

export function listExternalAgentsByConn(connId: string): ExternalAgentRegistration[] {
  const agentIds = connToAgents.get(connId);
  if (!agentIds) {
    return [];
  }
  return Array.from(agentIds)
    .map((id) => agents.get(id))
    .filter((r): r is ExternalAgentRegistration => r !== undefined);
}

/** For testing only */
export function __resetExternalAgentRegistryForTest(): void {
  agents.clear();
  connToAgents.clear();
}
