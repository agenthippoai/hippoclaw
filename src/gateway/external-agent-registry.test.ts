import { describe, it, expect, beforeEach } from "vitest";
import {
  registerExternalAgent,
  unregisterExternalAgent,
  unregisterAllExternalAgents,
  getExternalAgent,
  hasExternalAgent,
  listExternalAgents,
  listExternalAgentsByConn,
  __resetExternalAgentRegistryForTest,
} from "./external-agent-registry.js";
import type { GatewayWsClient } from "./server/ws-types.js";

// Mock client for testing
function mockClient(connId: string): GatewayWsClient {
  return {
    connId,
    socket: { send: () => {} } as unknown as import("ws").WebSocket,
    connect: {
      client: { id: "test", version: "1.0", platform: "test", mode: "agent-backend" },
    } as unknown as import("./protocol/index.js").ConnectParams,
  };
}

describe("ExternalAgentRegistry", () => {
  beforeEach(() => {
    __resetExternalAgentRegistryForTest();
  });

  describe("registerExternalAgent", () => {
    it("registers an agent with minimal info", () => {
      registerExternalAgent("conn-1", mockClient("conn-1"), { id: "test-agent" });

      expect(hasExternalAgent("test-agent")).toBe(true);
      const agent = getExternalAgent("test-agent");
      expect(agent).toBeDefined();
      expect(agent?.agentId).toBe("test-agent");
      expect(agent?.connId).toBe("conn-1");
    });

    it("registers an agent with full info", () => {
      registerExternalAgent("conn-1", mockClient("conn-1"), {
        id: "full-agent",
        name: "Full Agent",
        workspace: "/tmp/workspace",
        capabilities: ["text", "tools"],
      });

      const agent = getExternalAgent("full-agent");
      expect(agent).toBeDefined();
      expect(agent?.name).toBe("Full Agent");
      expect(agent?.workspace).toBe("/tmp/workspace");
      expect(agent?.capabilities).toEqual(["text", "tools"]);
    });

    it("overwrites existing agent with same id", () => {
      registerExternalAgent("conn-1", mockClient("conn-1"), { id: "agent-1", name: "First" });
      registerExternalAgent("conn-2", mockClient("conn-2"), { id: "agent-1", name: "Second" });

      const agent = getExternalAgent("agent-1");
      expect(agent?.connId).toBe("conn-2");
      expect(agent?.name).toBe("Second");
    });

    it("drops stale connection ownership when an agent re-registers elsewhere", () => {
      registerExternalAgent("conn-1", mockClient("conn-1"), { id: "agent-1" });
      registerExternalAgent("conn-2", mockClient("conn-2"), { id: "agent-1" });

      expect(listExternalAgentsByConn("conn-1")).toEqual([]);
      expect(listExternalAgentsByConn("conn-2").map((a) => a.agentId)).toEqual(["agent-1"]);
      expect(unregisterAllExternalAgents("conn-1")).toEqual([]);
      expect(hasExternalAgent("agent-1")).toBe(true);
    });
  });

  describe("unregisterExternalAgent", () => {
    it("removes an agent", () => {
      registerExternalAgent("conn-1", mockClient("conn-1"), { id: "agent-1" });
      expect(hasExternalAgent("agent-1")).toBe(true);

      const result = unregisterExternalAgent("conn-1", "agent-1");
      expect(result).toBe(true);
      expect(hasExternalAgent("agent-1")).toBe(false);
    });

    it("returns false for non-existent agent", () => {
      const result = unregisterExternalAgent("conn-1", "non-existent");
      expect(result).toBe(false);
    });

    it("returns false if connection doesn't own the agent", () => {
      registerExternalAgent("conn-1", mockClient("conn-1"), { id: "agent-1" });

      const result = unregisterExternalAgent("conn-2", "agent-1");
      expect(result).toBe(false);
      expect(hasExternalAgent("agent-1")).toBe(true);
    });
  });

  describe("unregisterAllExternalAgents", () => {
    it("removes all agents for a connection", () => {
      registerExternalAgent("conn-1", mockClient("conn-1"), { id: "agent-1" });
      registerExternalAgent("conn-1", mockClient("conn-1"), { id: "agent-2" });
      registerExternalAgent("conn-2", mockClient("conn-2"), { id: "agent-3" });

      const removed = unregisterAllExternalAgents("conn-1");
      expect(removed.toSorted()).toEqual(["agent-1", "agent-2"]);
      expect(hasExternalAgent("agent-1")).toBe(false);
      expect(hasExternalAgent("agent-2")).toBe(false);
      expect(hasExternalAgent("agent-3")).toBe(true);
    });

    it("returns empty array for unknown connection", () => {
      const removed = unregisterAllExternalAgents("unknown");
      expect(removed).toEqual([]);
    });
  });

  describe("listExternalAgents", () => {
    it("returns all registered agents", () => {
      registerExternalAgent("conn-1", mockClient("conn-1"), { id: "agent-1" });
      registerExternalAgent("conn-2", mockClient("conn-2"), { id: "agent-2" });

      const agents = listExternalAgents();
      expect(agents).toHaveLength(2);
      expect(agents.map((a) => a.agentId).toSorted()).toEqual(["agent-1", "agent-2"]);
    });
  });

  describe("listExternalAgentsByConn", () => {
    it("returns agents for a specific connection", () => {
      registerExternalAgent("conn-1", mockClient("conn-1"), { id: "agent-1" });
      registerExternalAgent("conn-1", mockClient("conn-1"), { id: "agent-2" });
      registerExternalAgent("conn-2", mockClient("conn-2"), { id: "agent-3" });

      const agents = listExternalAgentsByConn("conn-1");
      expect(agents).toHaveLength(2);
      expect(agents.map((a) => a.agentId).toSorted()).toEqual(["agent-1", "agent-2"]);
    });

    it("returns empty array for unknown connection", () => {
      const agents = listExternalAgentsByConn("unknown");
      expect(agents).toEqual([]);
    });
  });
});
