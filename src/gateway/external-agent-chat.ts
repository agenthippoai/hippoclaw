import type { MsgContext } from "../auto-reply/templating.js";
import { recordSessionMetaFromInbound } from "../config/sessions.js";
import type { ChatImageContent } from "./chat-attachments.js";
import {
  appendAssistantTranscriptMessage,
  appendUserTranscriptMessage,
} from "./chat-transcript.js";
import {
  isExternalAgent,
  requestNewExternalSession,
  tryRouteChatToExternal,
} from "./external-agent-handlers.js";
import { loadSessionEntry } from "./session-utils.js";

type ChatEntry = {
  sessionId?: string;
  sessionFile?: string;
};

/**
 * Check if a message is a session reset command (/new or /reset).
 * These should be intercepted before routing to external agents,
 * because external agents (e.g., IDE) don't understand slash commands.
 */
function isSessionResetCommand(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  return (
    normalized === "/new" ||
    normalized === "/reset" ||
    normalized.startsWith("/new ") ||
    normalized.startsWith("/reset ")
  );
}

export async function handleExternalAgentChatSend<TContext, TErrorCode>(opts: {
  agentId?: string;
  ctx: MsgContext;
  rawMessage: string;
  parsedMessage: string;
  parsedImages: ChatImageContent[];
  sessionKey: string;
  entry?: ChatEntry;
  storePath: string;
  clientRunId: string;
  context: TContext & {
    logGateway: { debug: (msg: string) => void; warn: (msg: string) => void };
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
  errorShape: (code: TErrorCode, msg: string) => unknown;
  errorCode: TErrorCode;
  channel: string;
}): Promise<boolean> {
  if (!opts.agentId || !isExternalAgent(opts.agentId)) {
    return false;
  }

  // Intercept /new and /reset commands — these should create a new IDE session,
  // not be forwarded as chat messages to the external agent.
  if (isSessionResetCommand(opts.parsedMessage)) {
    opts.context.logGateway.debug(
      `external-agent-chat: intercepting session reset command for ${opts.agentId}`,
    );

    try {
      const result = await requestNewExternalSession(
        opts.agentId,
        opts.channel ?? "webchat",
        undefined, // initialMessage
        opts.sessionKey, // pass sessionKey so IDE can update its session map
      );

      const now = Date.now();
      if (result.success && result.agentId) {
        opts.broadcastFinal({
          context: opts.context,
          runId: opts.clientRunId,
          sessionKey: opts.sessionKey,
          message: {
            role: "assistant",
            content: [
              {
                type: "text",
                text: `New session created: ${result.agentId}`,
              },
            ],
            timestamp: now,
            stopReason: "injected",
            usage: { input: 0, output: 0, totalTokens: 0 },
          },
        });
      } else {
        opts.broadcastError({
          context: opts.context,
          runId: opts.clientRunId,
          sessionKey: opts.sessionKey,
          errorMessage: result.error ?? "Failed to create new session",
        });
      }
    } catch (err) {
      opts.broadcastError({
        context: opts.context,
        runId: opts.clientRunId,
        sessionKey: opts.sessionKey,
        errorMessage: `Failed to create new session: ${String(err)}`,
      });
    }

    return true;
  }

  const recordedEntry = await recordSessionMetaFromInbound({
    storePath: opts.storePath,
    sessionKey: opts.sessionKey,
    ctx: opts.ctx,
    createIfMissing: true,
  });
  const sessionEntry = recordedEntry ?? opts.entry;
  const sessionId = sessionEntry?.sessionId ?? opts.clientRunId;
  const appendedUser = appendUserTranscriptMessage({
    message: opts.rawMessage,
    images: opts.parsedImages,
    sessionId,
    storePath: opts.storePath,
    sessionFile: sessionEntry?.sessionFile,
    createIfMissing: true,
  });
  if (!appendedUser.ok) {
    opts.context.logGateway.warn(
      `webchat transcript append failed for user message: ${appendedUser.error ?? "unknown error"}`,
    );
  }

  return tryRouteChatToExternal({
    agentId: opts.agentId,
    message: opts.parsedMessage,
    sessionKey: opts.sessionKey,
    sessionId: sessionEntry?.sessionId ?? opts.entry?.sessionId,
    channel: opts.channel,
    clientRunId: opts.clientRunId,
    context: opts.context,
    broadcastFinal: opts.broadcastFinal,
    broadcastError: opts.broadcastError,
    buildFinalMessage: (combinedReply) => {
      const { storePath: latestStorePath, entry: latestEntry } = loadSessionEntry(opts.sessionKey);
      const sessionId = latestEntry?.sessionId ?? sessionEntry?.sessionId ?? opts.clientRunId;
      const appended = appendAssistantTranscriptMessage({
        message: combinedReply,
        sessionId,
        storePath: latestStorePath,
        sessionFile: latestEntry?.sessionFile,
        createIfMissing: true,
      });
      if (appended.ok) {
        return appended.message;
      }
      if (combinedReply) {
        opts.context.logGateway.warn(
          `webchat transcript append failed: ${appended.error ?? "unknown error"}`,
        );
        const now = Date.now();
        return {
          role: "assistant",
          content: [{ type: "text", text: combinedReply }],
          timestamp: now,
          stopReason: "injected",
          usage: { input: 0, output: 0, totalTokens: 0 },
        };
      }
      return undefined;
    },
    errorShape: opts.errorShape,
    errorCode: opts.errorCode,
  });
}
