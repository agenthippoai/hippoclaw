import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  registerExternalAgent,
  __resetExternalAgentRegistryForTest,
} from "./external-agent-registry.js";
import {
  routeToExternalAgent,
  handleExternalAgentResponse,
  isExternalAgent,
  __resetExternalAgentRouterForTest,
} from "./external-agent-router.js";
import type { GatewayWsClient } from "./server/ws-types.js";

// Mock client with sendable socket
function mockClient(connId: string): GatewayWsClient & { sentMessages: string[] } {
  const sentMessages: string[] = [];
  return {
    connId,
    socket: {
      send: (data: string) => {
        sentMessages.push(data);
      },
      readyState: 1, // OPEN
    } as unknown as import("ws").WebSocket,
    connect: {
      client: { id: "test", version: "1.0", platform: "test", mode: "agent-backend" },
    } as unknown as import("./protocol/index.js").ConnectParams,
    sentMessages,
  };
}

describe("ExternalAgentRouter", () => {
  beforeEach(() => {
    __resetExternalAgentRouterForTest();
    __resetExternalAgentRegistryForTest();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("isExternalAgent", () => {
    it("returns false for unregistered agent", () => {
      expect(isExternalAgent("unknown-agent")).toBe(false);
    });

    it("returns true for registered external agent", () => {
      const client = mockClient("conn-1");
      registerExternalAgent("conn-1", client, { id: "my-agent" });

      expect(isExternalAgent("my-agent")).toBe(true);
    });
  });

  describe("routeToExternalAgent", () => {
    it("sends agent.run request to correct client", async () => {
      const client = mockClient("conn-1");
      registerExternalAgent("conn-1", client, { id: "ide-live" });

      // Start routing (don't await yet)
      const routePromise = routeToExternalAgent("ide-live", {
        message: "Hello from WhatsApp",
        agentId: "ide-live",
        sessionKey: "whatsapp:+1234567890",
        idempotencyKey: "idem-123",
      });

      // Wait a tick for the request to be sent
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Verify request was sent
      expect(client.sentMessages.length).toBe(1);
      const sentFrame = JSON.parse(client.sentMessages[0]);
      expect(sentFrame.type).toBe("req");
      expect(sentFrame.method).toBe("agent.run");
      expect(sentFrame.params).toMatchObject({
        message: "Hello from WhatsApp",
        agentId: "ide-live",
        sessionKey: "whatsapp:+1234567890",
        idempotencyKey: "idem-123",
      });

      // Simulate response from external agent
      handleExternalAgentResponse(sentFrame.id, true, {
        text: "Hello! This is the response.",
        runId: "run-456",
      });

      const result = await routePromise;
      expect(result).toEqual({
        text: "Hello! This is the response.",
        runId: "run-456",
      });
    });

    it("rejects when agent is not registered", async () => {
      await expect(
        routeToExternalAgent("unknown-agent", {
          message: "test",
          agentId: "unknown-agent",
          idempotencyKey: "idem-1",
        }),
      ).rejects.toThrow("External agent unknown-agent not found");
    });

    it("rejects when external agent returns error", async () => {
      const client = mockClient("conn-1");
      registerExternalAgent("conn-1", client, { id: "test-agent" });

      const routePromise = routeToExternalAgent("test-agent", {
        message: "test",
        agentId: "test-agent",
        idempotencyKey: "idem-2",
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      const sentFrame = JSON.parse(client.sentMessages[0]);
      handleExternalAgentResponse(sentFrame.id, false, undefined, {
        code: "AGENT_ERROR",
        message: "Something went wrong",
      });

      await expect(routePromise).rejects.toThrow("Something went wrong");
    });

    it("times out if no response", async () => {
      const client = mockClient("conn-1");
      registerExternalAgent("conn-1", client, { id: "slow-agent" });

      // Use a very short timeout (50ms) to make the test fast
      const routePromise = routeToExternalAgent(
        "slow-agent",
        {
          message: "test",
          agentId: "slow-agent",
          idempotencyKey: "idem-3",
        },
        { timeoutMs: 50 },
      );

      await expect(routePromise).rejects.toThrow("timed out");
    });
  });

  describe("handleExternalAgentResponse", () => {
    it("returns false for unknown request id", () => {
      const result = handleExternalAgentResponse("unknown-id", true, { text: "hi" });
      expect(result).toBe(false);
    });

    it("returns true and resolves pending request", async () => {
      const client = mockClient("conn-1");
      registerExternalAgent("conn-1", client, { id: "agent-1" });

      const routePromise = routeToExternalAgent("agent-1", {
        message: "test",
        agentId: "agent-1",
        idempotencyKey: "idem-4",
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      const sentFrame = JSON.parse(client.sentMessages[0]);
      const result = handleExternalAgentResponse(sentFrame.id, true, { text: "response" });
      expect(result).toBe(true);

      const response = await routePromise;
      expect(response.text).toBe("response");
    });

    it("ignores responses from the wrong connection", async () => {
      const client = mockClient("conn-1");
      registerExternalAgent("conn-1", client, { id: "agent-1" });

      const routePromise = routeToExternalAgent(
        "agent-1",
        {
          message: "test",
          agentId: "agent-1",
          idempotencyKey: "idem-5",
        },
        { timeoutMs: 50 },
      );

      await new Promise((resolve) => setTimeout(resolve, 10));

      const sentFrame = JSON.parse(client.sentMessages[0]);
      expect(
        handleExternalAgentResponse(sentFrame.id, true, { text: "spoofed" }, undefined, "conn-2"),
      ).toBe(false);

      handleExternalAgentResponse(sentFrame.id, true, { text: "response" }, undefined, "conn-1");
      await expect(routePromise).resolves.toMatchObject({ text: "response" });
    });
  });

  describe("routing isolation", () => {
    it("routes to correct agent based on agentId", async () => {
      const client1 = mockClient("conn-1");
      const client2 = mockClient("conn-2");

      registerExternalAgent("conn-1", client1, { id: "agent-1" });
      registerExternalAgent("conn-2", client2, { id: "agent-2" });

      // Route to agent-1
      const route1Promise = routeToExternalAgent("agent-1", {
        message: "for agent 1",
        agentId: "agent-1",
        idempotencyKey: "idem-a1",
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      // Only client1 should have received the message
      expect(client1.sentMessages.length).toBe(1);
      expect(client2.sentMessages.length).toBe(0);

      const frame1 = JSON.parse(client1.sentMessages[0]);
      expect(frame1.params.message).toBe("for agent 1");

      // Respond
      handleExternalAgentResponse(frame1.id, true, { text: "from agent 1" });
      const result1 = await route1Promise;
      expect(result1.text).toBe("from agent 1");

      // Now route to agent-2
      const route2Promise = routeToExternalAgent("agent-2", {
        message: "for agent 2",
        agentId: "agent-2",
        idempotencyKey: "idem-a2",
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      // Only client2 should have received this message
      expect(client1.sentMessages.length).toBe(1); // Still 1
      expect(client2.sentMessages.length).toBe(1);

      const frame2 = JSON.parse(client2.sentMessages[0]);
      expect(frame2.params.message).toBe("for agent 2");

      handleExternalAgentResponse(frame2.id, true, { text: "from agent 2" });
      const result2 = await route2Promise;
      expect(result2.text).toBe("from agent 2");
    });

    it("multiple agents on same connection are correctly routed", async () => {
      const client = mockClient("conn-1");

      registerExternalAgent("conn-1", client, { id: "agent-a" });
      registerExternalAgent("conn-1", client, { id: "agent-b" });

      // Both agents are on the same connection
      expect(isExternalAgent("agent-a")).toBe(true);
      expect(isExternalAgent("agent-b")).toBe(true);

      // Route to agent-a
      const routeAPromise = routeToExternalAgent("agent-a", {
        message: "for A",
        agentId: "agent-a",
        idempotencyKey: "idem-aa",
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(client.sentMessages.length).toBe(1);
      const frameA = JSON.parse(client.sentMessages[0]);
      expect(frameA.params.agentId).toBe("agent-a");

      handleExternalAgentResponse(frameA.id, true, { text: "response A" });
      const resultA = await routeAPromise;
      expect(resultA.text).toBe("response A");

      // Route to agent-b
      const routeBPromise = routeToExternalAgent("agent-b", {
        message: "for B",
        agentId: "agent-b",
        idempotencyKey: "idem-bb",
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(client.sentMessages.length).toBe(2);
      const frameB = JSON.parse(client.sentMessages[1]);
      expect(frameB.params.agentId).toBe("agent-b");

      handleExternalAgentResponse(frameB.id, true, { text: "response B" });
      const resultB = await routeBPromise;
      expect(resultB.text).toBe("response B");
    });
  });
});
