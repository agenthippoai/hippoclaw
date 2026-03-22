import {
  resolveDefaultAgentId,
  resolveInboundEffectiveAgentId,
  resolveSessionAgentId,
} from "../../agents/agent-scope.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  loadSessionStore,
  resolveSessionStoreEntry,
  resolveStorePath,
  type SessionEntry,
} from "../../config/sessions.js";
import { shouldSuppressLocalDiscordExecApprovalPrompt } from "../../discord/exec-approvals.js";
import { requestNewExternalSession } from "../../gateway/external-agent-handlers.js";
import {
  cancelExternalAgentRun,
  cancelExternalAgentRunByPeerKey,
  isExternalAgent,
  routeToExternalAgent,
  sendCancelToExternalAgent,
  type ExternalAgentStreamEvent,
  type MediaAttachment,
} from "../../gateway/external-agent-router.js";
import { logVerbose } from "../../globals.js";
import { fireAndForgetHook } from "../../hooks/fire-and-forget.js";
import { createInternalHookEvent, triggerInternalHook } from "../../hooks/internal-hooks.js";
import {
  deriveInboundMessageHookContext,
  toInternalMessageReceivedContext,
  toPluginMessageContext,
  toPluginMessageReceivedEvent,
} from "../../hooks/message-hook-mappers.js";
import { isDiagnosticsEnabled } from "../../infra/diagnostic-events.js";
import {
  logMessageProcessed,
  logMessageQueued,
  logSessionStateChange,
} from "../../logging/diagnostic.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import {
  isIdeGatewayExternalAgentId,
  resolveInboundAgentSessionKey,
} from "../../routing/session-key.js";
import { resolveSendPolicy } from "../../sessions/send-policy.js";
import { maybeApplyTtsToPayload, normalizeTtsAutoMode, resolveTtsConfig } from "../../tts/tts.js";
import { INTERNAL_MESSAGE_CHANNEL, normalizeMessageChannel } from "../../utils/message-channel.js";
import { getReplyFromConfig } from "../reply.js";
import type { FinalizedMsgContext, MsgContext } from "../templating.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import { formatAbortReplyText, tryFastAbortFromMessage } from "./abort.js";
import { shouldBypassAcpDispatchForCommand, tryDispatchAcpReply } from "./dispatch-acp.js";
import { shouldSkipDuplicateInbound } from "./inbound-dedupe.js";
import type { ReplyDispatcher, ReplyDispatchKind } from "./reply-dispatcher.js";
import { shouldSuppressReasoningPayload } from "./reply-payloads.js";
import { isRoutableChannel, routeReply } from "./route-reply.js";
import { resolveRunTypingPolicy } from "./typing-policy.js";

// ============================================================================
// External Agent Reply Resolver
// ============================================================================

/**
 * Create a reply resolver for external agents (e.g., IDE agents connected via gateway).
 *
 * This is a drop-in replacement for `getReplyFromConfig` that routes messages to
 * an external agent backend instead of running the embedded Pi agent.
 *
 * By plugging into the same `replyResolver` interface, external agents automatically
 * get all channel delivery features: typing indicators, ack reactions, block streaming,
 * TTS, reply threading, response prefix, and diagnostic events.
 *
 * ## What the external agent path SKIPS (left to the external agent):
 *
 * - **Media understanding** — no image/audio/video pre-processing via vision or
 *   transcription models. The external agent receives raw file paths and handles
 *   media directly (e.g., the IDE agent can read images from disk).
 *
 * - **Session management** — no OpenClaw session store, compaction, or transcript
 *   persistence. The external agent (IDE) manages its own sessions.
 *
 * - **Model selection / API keys** — no model resolution or auth profile lookup.
 *   The external agent uses its own model configuration.
 *
 * - **Command parsing** — no skill/directive/command processing. The raw message
 *   text is forwarded as-is.
 *
 * - **Workspace/agent dir setup** — no personality files, memory, or notes loading.
 *   The external agent has its own workspace.
 *
 * - **Link understanding** — no URL preview/extraction.
 */
function createExternalAgentReplyResolver(
  agentId: string,
  channel: string,
  messageId: string | undefined,
): typeof getReplyFromConfig {
  return async (
    ctx: MsgContext,
    _opts?: GetReplyOptions,
    _cfg?: OpenClawConfig,
  ): Promise<ReplyPayload | ReplyPayload[] | undefined> => {
    // Intercept /new and /reset — trigger session.new on the IDE instead of
    // forwarding as text (which would bypass session reset and confuse the agent).
    const rawCmd = (ctx.CommandBody ?? ctx.RawBody ?? ctx.Body ?? "").trim().toLowerCase();
    if (rawCmd === "/new" || rawCmd === "/reset") {
      const sessionKey = ctx.SessionKey;
      const result = await requestNewExternalSession(agentId, channel, undefined, sessionKey);
      if (result.success) {
        return { text: "✅ New session started." };
      }
      return { text: `⚠️ Failed to start new session: ${result.error ?? "unknown error"}` };
    }

    // Strip <media:*> placeholders — they're for the internal media understanding pipeline.
    // External agents receive raw file paths instead and handle media directly.
    const stripMediaTags = (text: string) =>
      text.replace(/<media:\w+>(\s*\([^)]*\))?/gi, "").trim();
    const rawBody =
      typeof ctx.BodyForCommands === "string"
        ? ctx.BodyForCommands
        : typeof ctx.RawBody === "string"
          ? ctx.RawBody
          : typeof ctx.Body === "string"
            ? ctx.Body
            : "";
    const messageBody = stripMediaTags(rawBody);

    // Build media attachments from context and include file paths in message body.
    // External agents handle files directly — no vision/transcription pre-processing.
    const attachments: MediaAttachment[] = [];
    const mediaPaths = ctx.MediaPaths ?? (ctx.MediaPath ? [ctx.MediaPath] : []);
    const mediaUrls = ctx.MediaUrls ?? (ctx.MediaUrl ? [ctx.MediaUrl] : []);
    const mediaTypes = ctx.MediaTypes ?? (ctx.MediaType ? [ctx.MediaType] : []);
    for (let i = 0; i < Math.max(mediaPaths.length, mediaUrls.length); i++) {
      const mimeType = mediaTypes[i] ?? "";
      const kind = mimeType.startsWith("image")
        ? ("image" as const)
        : mimeType.startsWith("audio")
          ? ("audio" as const)
          : mimeType.startsWith("video")
            ? ("video" as const)
            : ("document" as const);
      attachments.push({
        type: kind,
        path: mediaPaths[i],
        url: mediaUrls[i],
        mimeType: mimeType || undefined,
      });
    }

    let fullMessageBody = messageBody;
    if (attachments.length > 0) {
      const fileRefs = attachments.map((a) => a.path || a.url || "").filter(Boolean);
      if (fileRefs.length > 0) {
        const fileList =
          fileRefs.length === 1
            ? `The user sent a file: ${fileRefs[0]}`
            : `The user sent ${fileRefs.length} files:\n${fileRefs.map((f) => `- ${f}`).join("\n")}`;
        fullMessageBody = fullMessageBody ? `${fileList}\n\n${fullMessageBody}` : fileList;
      }
    }

    const sessionKey = ctx.SessionKey;

    // Drive typing indicators while waiting for external agent response.
    // Telegram typing expires after ~5s, so refresh every 4s.
    const TYPING_INTERVAL_MS = 4000;
    const onReplyStart = _opts?.onReplyStart;
    if (onReplyStart) {
      try {
        await onReplyStart();
      } catch {
        // Best-effort typing signal.
      }
    }
    const typingTimer = onReplyStart
      ? setInterval(() => {
          void Promise.resolve(onReplyStart()).catch(() => {});
        }, TYPING_INTERVAL_MS)
      : undefined;

    // Strip thinking tokens from response text.
    const stripThinking = (text: string) =>
      text.replace(/<thinking>[\s\S]*?<\/thinking>\s*/g, "").trim();

    // Block streaming for external agents: emit text blocks at natural boundaries
    // (text → thinking and text → tool_start transitions). This delivers intermediate
    // responses as soon as a text block completes, without waiting for the full agent
    // turn and without spamming a bubble on every streaming delta.
    // If the agent writes a single text block with no tools or thinking breaks,
    // no intermediate blocks are emitted — a single final message is sent.
    // Draft streaming (onPartialReply, single-message in-place edit) is also supported
    // when the channel provides it (Telegram private chats with topics enabled).
    const onBlockReply = _opts?.disableBlockStreaming ? undefined : _opts?.onBlockReply;
    const onPartialReply = _opts?.onPartialReply;
    let lastStreamedText = "";
    let latestCleanedText = "";
    // Track the accumulated text at each block emission point.
    // The final reply sends only text after the last emitted block.
    let lastBlockCleanedText = "";

    const maybeEmitBlock = () => {
      if (!onBlockReply || latestCleanedText === lastBlockCleanedText) {
        return;
      }
      const blockText = latestCleanedText.trim();
      if (blockText) {
        lastBlockCleanedText = latestCleanedText;
        void Promise.resolve(onBlockReply({ text: blockText })).catch(() => {});
      }
    };

    const onStream =
      onBlockReply || onPartialReply
        ? (event: ExternalAgentStreamEvent) => {
            if (event.state === "delta" && event.text) {
              const cleaned = stripThinking(event.text);
              if (!cleaned) {
                return;
              }
              latestCleanedText = cleaned;

              // Draft streaming: edit a single message in-place with accumulated text.
              if (onPartialReply && cleaned !== lastStreamedText) {
                void Promise.resolve(onPartialReply({ text: cleaned })).catch(() => {});
                lastStreamedText = cleaned;
              }
            }

            // Emit a block reply at natural boundaries: when the agent transitions
            // from text to thinking or from text to tool use, the preceding text
            // block is complete and can be sent to the channel immediately.
            if (
              event.state === "thinking" ||
              (event.state === "tool" && event.toolState === "start")
            ) {
              maybeEmitBlock();
            }
          }
        : undefined;

    let result: { text: string; runId?: string };
    try {
      result = await routeToExternalAgent(
        agentId,
        {
          message: fullMessageBody,
          agentId,
          sessionKey,
          channel,
          senderUsername: typeof ctx.SenderUsername === "string" ? ctx.SenderUsername : undefined,
          senderName: typeof ctx.SenderName === "string" ? ctx.SenderName : undefined,
          senderId: typeof ctx.SenderId === "string" ? ctx.SenderId : String(ctx.SenderId ?? ""),
          attachments: attachments.length > 0 ? attachments : undefined,
          idempotencyKey: `channel:${messageId ?? Date.now()}`,
        },
        { onStream },
      );
    } catch (err) {
      // If cancelled by user abort, return silently — the abort message
      // is sent from the second message's dispatch path.
      if (err instanceof Error && err.message.includes("cancelled by user")) {
        return undefined;
      }
      throw err;
    } finally {
      if (typingTimer) {
        clearInterval(typingTimer);
      }
    }

    // Strip thinking tokens from the final response.
    const replyText = stripThinking(result.text?.trim() ?? "");

    if (!replyText) {
      return undefined;
    }

    // If blocks were sent, only return text that appeared after the last block.
    // Each block contains the full accumulated text up to that boundary, so
    // return only the suffix when the final text starts with what was sent.
    if (lastBlockCleanedText) {
      const lastBlock = lastBlockCleanedText.trim();
      if (replyText.length <= lastBlock.length) {
        return undefined; // Nothing new after the last block.
      }
      if (replyText.startsWith(lastBlock)) {
        const remaining = replyText.slice(lastBlock.length).trim();
        return remaining ? { text: remaining } : undefined;
      }
      // Fallback: if the final text doesn't start with the last block,
      // return it as-is to avoid dropping content.
      return { text: replyText };
    }

    return { text: replyText };
  };
}

const AUDIO_PLACEHOLDER_RE = /^<media:audio>(\s*\([^)]*\))?$/i;
const AUDIO_HEADER_RE = /^\[Audio\b/i;
const normalizeMediaType = (value: string): string => value.split(";")[0]?.trim().toLowerCase();

const isInboundAudioContext = (ctx: FinalizedMsgContext): boolean => {
  const rawTypes = [
    typeof ctx.MediaType === "string" ? ctx.MediaType : undefined,
    ...(Array.isArray(ctx.MediaTypes) ? ctx.MediaTypes : []),
  ].filter(Boolean) as string[];
  const types = rawTypes.map((type) => normalizeMediaType(type));
  if (types.some((type) => type === "audio" || type.startsWith("audio/"))) {
    return true;
  }

  const body =
    typeof ctx.BodyForCommands === "string"
      ? ctx.BodyForCommands
      : typeof ctx.CommandBody === "string"
        ? ctx.CommandBody
        : typeof ctx.RawBody === "string"
          ? ctx.RawBody
          : typeof ctx.Body === "string"
            ? ctx.Body
            : "";
  const trimmed = body.trim();
  if (!trimmed) {
    return false;
  }
  if (AUDIO_PLACEHOLDER_RE.test(trimmed)) {
    return true;
  }
  return AUDIO_HEADER_RE.test(trimmed);
};

const resolveSessionStoreLookup = (
  ctx: FinalizedMsgContext,
  cfg: OpenClawConfig,
): {
  sessionKey?: string;
  entry?: SessionEntry;
} => {
  const sessionKey = resolveInboundAgentSessionKey(ctx);
  if (!sessionKey) {
    return {};
  }
  const agentId = resolveSessionAgentId({ sessionKey, config: cfg });
  const storePath = resolveStorePath(cfg.session?.store, { agentId });
  try {
    const store = loadSessionStore(storePath);
    return {
      sessionKey,
      entry: resolveSessionStoreEntry({ store, sessionKey }).existing,
    };
  } catch {
    return {
      sessionKey,
    };
  }
};

export type DispatchFromConfigResult = {
  queuedFinal: boolean;
  counts: Record<ReplyDispatchKind, number>;
};

export async function dispatchReplyFromConfig(params: {
  ctx: FinalizedMsgContext;
  cfg: OpenClawConfig;
  dispatcher: ReplyDispatcher;
  replyOptions?: Omit<GetReplyOptions, "onToolResult" | "onBlockReply">;
  replyResolver?: typeof getReplyFromConfig;
}): Promise<DispatchFromConfigResult> {
  const { ctx, cfg, dispatcher } = params;
  const diagnosticsEnabled = isDiagnosticsEnabled(cfg);
  const channel = String(ctx.Surface ?? ctx.Provider ?? "unknown").toLowerCase();
  const chatId = ctx.To ?? ctx.From;
  const messageId = ctx.MessageSid ?? ctx.MessageSidFirst ?? ctx.MessageSidLast;
  const sessionKey = ctx.SessionKey;
  const startTime = diagnosticsEnabled ? Date.now() : 0;
  const canTrackSession = diagnosticsEnabled && Boolean(sessionKey);

  const recordProcessed = (
    outcome: "completed" | "skipped" | "error",
    opts?: {
      reason?: string;
      error?: string;
    },
  ) => {
    if (!diagnosticsEnabled) {
      return;
    }
    logMessageProcessed({
      channel,
      chatId,
      messageId,
      sessionKey,
      durationMs: Date.now() - startTime,
      outcome,
      reason: opts?.reason,
      error: opts?.error,
    });
  };

  const markProcessing = () => {
    if (!canTrackSession || !sessionKey) {
      return;
    }
    logMessageQueued({ sessionKey, channel, source: "dispatch" });
    logSessionStateChange({
      sessionKey,
      state: "processing",
      reason: "message_start",
    });
  };

  const markIdle = (reason: string) => {
    if (!canTrackSession || !sessionKey) {
      return;
    }
    logSessionStateChange({
      sessionKey,
      state: "idle",
      reason,
    });
  };

  if (shouldSkipDuplicateInbound(ctx)) {
    recordProcessed("skipped", { reason: "duplicate" });
    return { queuedFinal: false, counts: dispatcher.getQueuedCounts() };
  }

  const sessionStoreEntry = resolveSessionStoreLookup(ctx, cfg);
  const acpDispatchSessionKey = sessionStoreEntry.sessionKey ?? sessionKey;
  const inboundAudio = isInboundAudioContext(ctx);
  const sessionTtsAuto = normalizeTtsAutoMode(sessionStoreEntry.entry?.ttsAuto);
  const hookRunner = getGlobalHookRunner();

  // Extract message context for hooks (plugin and internal)
  const timestamp =
    typeof ctx.Timestamp === "number" && Number.isFinite(ctx.Timestamp) ? ctx.Timestamp : undefined;
  const messageIdForHook =
    ctx.MessageSidFull ?? ctx.MessageSid ?? ctx.MessageSidFirst ?? ctx.MessageSidLast;
  const hookContext = deriveInboundMessageHookContext(ctx, { messageId: messageIdForHook });
  const { isGroup, groupId } = hookContext;

  // Trigger plugin hooks (fire-and-forget)
  if (hookRunner?.hasHooks("message_received")) {
    fireAndForgetHook(
      hookRunner.runMessageReceived(
        toPluginMessageReceivedEvent(hookContext),
        toPluginMessageContext(hookContext),
      ),
      "dispatch-from-config: message_received plugin hook failed",
    );
  }

  // Bridge to internal hooks (HOOK.md discovery system) - refs #8807
  if (sessionKey) {
    fireAndForgetHook(
      triggerInternalHook(
        createInternalHookEvent("message", "received", sessionKey, {
          ...toInternalMessageReceivedContext(hookContext),
          timestamp,
        }),
      ),
      "dispatch-from-config: message_received internal hook failed",
    );
  }

  // Check if we should route replies to originating channel instead of dispatcher.
  // Only route when the originating channel is DIFFERENT from the current surface.
  // This handles cross-provider routing (e.g., message from Telegram being processed
  // by a shared session that's currently on Slack) while preserving normal dispatcher
  // flow when the provider handles its own messages.
  //
  // Debug: `pnpm test src/auto-reply/reply/dispatch-from-config.test.ts`
  const originatingChannel = normalizeMessageChannel(ctx.OriginatingChannel);
  const originatingTo = ctx.OriginatingTo;
  const providerChannel = normalizeMessageChannel(ctx.Provider);
  const surfaceChannel = normalizeMessageChannel(ctx.Surface);
  // Prefer provider channel because surface may carry origin metadata in relayed flows.
  const currentSurface = providerChannel ?? surfaceChannel;
  const isInternalWebchatTurn =
    currentSurface === INTERNAL_MESSAGE_CHANNEL &&
    (surfaceChannel === INTERNAL_MESSAGE_CHANNEL || !surfaceChannel) &&
    ctx.ExplicitDeliverRoute !== true;
  const shouldRouteToOriginating = Boolean(
    !isInternalWebchatTurn &&
    isRoutableChannel(originatingChannel) &&
    originatingTo &&
    originatingChannel !== currentSurface,
  );
  const shouldSuppressTyping =
    shouldRouteToOriginating || originatingChannel === INTERNAL_MESSAGE_CHANNEL;
  const ttsChannel = shouldRouteToOriginating ? originatingChannel : currentSurface;

  /**
   * Helper to send a payload via route-reply (async).
   * Only used when actually routing to a different provider.
   * Note: Only called when shouldRouteToOriginating is true, so
   * originatingChannel and originatingTo are guaranteed to be defined.
   */
  const sendPayloadAsync = async (
    payload: ReplyPayload,
    abortSignal?: AbortSignal,
    mirror?: boolean,
  ): Promise<void> => {
    // TypeScript doesn't narrow these from the shouldRouteToOriginating check,
    // but they're guaranteed non-null when this function is called.
    if (!originatingChannel || !originatingTo) {
      return;
    }
    if (abortSignal?.aborted) {
      return;
    }
    const result = await routeReply({
      payload,
      channel: originatingChannel,
      to: originatingTo,
      sessionKey: ctx.SessionKey,
      accountId: ctx.AccountId,
      threadId: ctx.MessageThreadId,
      cfg,
      abortSignal,
      mirror,
      isGroup,
      groupId,
    });
    if (!result.ok) {
      logVerbose(`dispatch-from-config: route-reply failed: ${result.error ?? "unknown error"}`);
    }
  };

  markProcessing();

  // Resolve the reply resolver: use external agent resolver if the target is external,
  // otherwise fall through to the standard embedded agent path (getReplyFromConfig).
  // If the session is bound to a non-default agent that isn't currently connected,
  // return a friendly error instead of falling through to the embedded Pi agent.
  // (agenthippo3 behavior: only the default agent uses embedded; secondary agents are
  // external backends or show "not connected".)
  //
  // If the IDE agent id is also marked `default` in config, targetAgentId === defaultAgentId
  // unless we treat `ide-*` explicitly — otherwise the gateway runs embedded Pi for that id
  // and fails (no API keys in the IDE agentDir on the gateway).
  //
  // Native commands (e.g., Telegram /new) use a synthetic SessionKey like
  // "telegram:slash:PEERID" which doesn't contain the agent ID. The actual
  // agent-prefixed session key is in CommandTargetSessionKey — use it when present.
  const targetAgentId = resolveInboundEffectiveAgentId(ctx, cfg);
  const defaultAgentId = resolveDefaultAgentId(cfg);
  const useDisconnectedStub =
    isIdeGatewayExternalAgentId(targetAgentId) ||
    (targetAgentId !== defaultAgentId && cfg.acp?.enabled !== true);
  const replyResolver = isExternalAgent(targetAgentId)
    ? createExternalAgentReplyResolver(targetAgentId, channel, messageId)
    : useDisconnectedStub
      ? async () => ({
          text: "⚠️ Agent is not connected. Connect your editor (Agent Anywhere) to the OpenClaw gateway.",
        })
      : (params.replyResolver ?? getReplyFromConfig);

  try {
    const fastAbort = await tryFastAbortFromMessage({ ctx, cfg });
    if (fastAbort.handled) {
      // Cancel pending external agent run if the target is external.
      // This both rejects the pending promise (gateway-side) and tells the IDE to stop.
      if (sessionKey && isExternalAgent(targetAgentId)) {
        // Direct match: the abort message resolves to an external agent
        cancelExternalAgentRun(sessionKey);
        sendCancelToExternalAgent(targetAgentId, sessionKey);
      } else {
        // Indirect match: abort message may use a different sessionKey format
        // (e.g., Telegram /stop uses "telegram:slash:PEERID" while the active
        // run has "agent:ide-myagent1:dm:PEERID"). Look up by exact peer key
        // ({channel}:{senderId}) which is indexed when the run starts.
        const peerChannel = (
          ctx.OriginatingChannel ??
          ctx.Surface ??
          ctx.Provider ??
          ""
        ).toLowerCase();
        const peerId = String(ctx.SenderId ?? "");
        const match = cancelExternalAgentRunByPeerKey(peerChannel, peerId);
        if (match) {
          sendCancelToExternalAgent(match.agentId, match.sessionKey);
        }
      }
      const payload = {
        text: formatAbortReplyText(fastAbort.stoppedSubagents),
      } satisfies ReplyPayload;
      let queuedFinal = false;
      let routedFinalCount = 0;
      if (shouldRouteToOriginating && originatingChannel && originatingTo) {
        const result = await routeReply({
          payload,
          channel: originatingChannel,
          to: originatingTo,
          sessionKey: ctx.SessionKey,
          accountId: ctx.AccountId,
          threadId: ctx.MessageThreadId,
          cfg,
          isGroup,
          groupId,
        });
        queuedFinal = result.ok;
        if (result.ok) {
          routedFinalCount += 1;
        }
        if (!result.ok) {
          logVerbose(
            `dispatch-from-config: route-reply (abort) failed: ${result.error ?? "unknown error"}`,
          );
        }
      } else {
        queuedFinal = dispatcher.sendFinalReply(payload);
      }
      const counts = dispatcher.getQueuedCounts();
      counts.final += routedFinalCount;
      recordProcessed("completed", { reason: "fast_abort" });
      markIdle("message_completed");
      return { queuedFinal, counts };
    }

    const bypassAcpForCommand = shouldBypassAcpDispatchForCommand(ctx, cfg);

    const sendPolicy = resolveSendPolicy({
      cfg,
      entry: sessionStoreEntry.entry,
      sessionKey: sessionStoreEntry.sessionKey ?? sessionKey,
      channel:
        sessionStoreEntry.entry?.channel ??
        ctx.OriginatingChannel ??
        ctx.Surface ??
        ctx.Provider ??
        undefined,
      chatType: sessionStoreEntry.entry?.chatType,
    });
    if (sendPolicy === "deny" && !bypassAcpForCommand) {
      logVerbose(
        `Send blocked by policy for session ${sessionStoreEntry.sessionKey ?? sessionKey ?? "unknown"}`,
      );
      const counts = dispatcher.getQueuedCounts();
      recordProcessed("completed", { reason: "send_policy_deny" });
      markIdle("message_completed");
      return { queuedFinal: false, counts };
    }

    const shouldSendToolSummaries = ctx.ChatType !== "group" && ctx.CommandSource !== "native";
    const acpDispatch = await tryDispatchAcpReply({
      ctx,
      cfg,
      dispatcher,
      sessionKey: acpDispatchSessionKey,
      inboundAudio,
      sessionTtsAuto,
      ttsChannel,
      shouldRouteToOriginating,
      originatingChannel,
      originatingTo,
      shouldSendToolSummaries,
      bypassForCommand: bypassAcpForCommand,
      onReplyStart: params.replyOptions?.onReplyStart,
      recordProcessed,
      markIdle,
    });
    if (acpDispatch) {
      return acpDispatch;
    }

    // Track accumulated block text for TTS generation after streaming completes.
    // When block streaming succeeds, there's no final reply, so we need to generate
    // TTS audio separately from the accumulated block content.
    let accumulatedBlockText = "";
    let blockCount = 0;

    const resolveToolDeliveryPayload = (payload: ReplyPayload): ReplyPayload | null => {
      if (
        normalizeMessageChannel(ctx.Surface ?? ctx.Provider) === "discord" &&
        shouldSuppressLocalDiscordExecApprovalPrompt({
          cfg,
          accountId: ctx.AccountId,
          payload,
        })
      ) {
        return null;
      }
      if (shouldSendToolSummaries) {
        return payload;
      }
      const execApproval =
        payload.channelData &&
        typeof payload.channelData === "object" &&
        !Array.isArray(payload.channelData)
          ? payload.channelData.execApproval
          : undefined;
      if (execApproval && typeof execApproval === "object" && !Array.isArray(execApproval)) {
        return payload;
      }
      // Group/native flows intentionally suppress tool summary text, but media-only
      // tool results (for example TTS audio) must still be delivered.
      const hasMedia = Boolean(payload.mediaUrl) || (payload.mediaUrls?.length ?? 0) > 0;
      if (!hasMedia) {
        return null;
      }
      return { ...payload, text: undefined };
    };
    const typing = resolveRunTypingPolicy({
      requestedPolicy: params.replyOptions?.typingPolicy,
      suppressTyping: params.replyOptions?.suppressTyping === true || shouldSuppressTyping,
      originatingChannel,
      systemEvent: shouldRouteToOriginating,
    });

    const replyResult = await replyResolver(
      ctx,
      {
        ...params.replyOptions,
        typingPolicy: typing.typingPolicy,
        suppressTyping: typing.suppressTyping,
        onToolResult: (payload: ReplyPayload) => {
          const run = async () => {
            const ttsPayload = await maybeApplyTtsToPayload({
              payload,
              cfg,
              channel: ttsChannel,
              kind: "tool",
              inboundAudio,
              ttsAuto: sessionTtsAuto,
            });
            const deliveryPayload = resolveToolDeliveryPayload(ttsPayload);
            if (!deliveryPayload) {
              return;
            }
            if (shouldRouteToOriginating) {
              await sendPayloadAsync(deliveryPayload, undefined, false);
            } else {
              dispatcher.sendToolResult(deliveryPayload);
            }
          };
          return run();
        },
        onBlockReply: (payload: ReplyPayload, context) => {
          const run = async () => {
            // Suppress reasoning payloads — channels using this generic dispatch
            // path (WhatsApp, web, etc.) do not have a dedicated reasoning lane.
            // Telegram has its own dispatch path that handles reasoning splitting.
            if (shouldSuppressReasoningPayload(payload)) {
              return;
            }
            // Accumulate block text for TTS generation after streaming
            if (payload.text) {
              if (accumulatedBlockText.length > 0) {
                accumulatedBlockText += "\n";
              }
              accumulatedBlockText += payload.text;
              blockCount++;
            }
            const ttsPayload = await maybeApplyTtsToPayload({
              payload,
              cfg,
              channel: ttsChannel,
              kind: "block",
              inboundAudio,
              ttsAuto: sessionTtsAuto,
            });
            if (shouldRouteToOriginating) {
              await sendPayloadAsync(ttsPayload, context?.abortSignal, false);
            } else {
              dispatcher.sendBlockReply(ttsPayload);
            }
          };
          return run();
        },
      },
      cfg,
    );

    if (ctx.AcpDispatchTailAfterReset === true) {
      // Command handling prepared a trailing prompt after ACP in-place reset.
      // Route that tail through ACP now (same turn) instead of embedded dispatch.
      ctx.AcpDispatchTailAfterReset = false;
      const acpTailDispatch = await tryDispatchAcpReply({
        ctx,
        cfg,
        dispatcher,
        sessionKey: acpDispatchSessionKey,
        inboundAudio,
        sessionTtsAuto,
        ttsChannel,
        shouldRouteToOriginating,
        originatingChannel,
        originatingTo,
        shouldSendToolSummaries,
        bypassForCommand: false,
        onReplyStart: params.replyOptions?.onReplyStart,
        recordProcessed,
        markIdle,
      });
      if (acpTailDispatch) {
        return acpTailDispatch;
      }
    }

    const replies = replyResult ? (Array.isArray(replyResult) ? replyResult : [replyResult]) : [];

    let queuedFinal = false;
    let routedFinalCount = 0;
    for (const reply of replies) {
      // Suppress reasoning payloads from channel delivery — channels using this
      // generic dispatch path do not have a dedicated reasoning lane.
      if (shouldSuppressReasoningPayload(reply)) {
        continue;
      }
      const ttsReply = await maybeApplyTtsToPayload({
        payload: reply,
        cfg,
        channel: ttsChannel,
        kind: "final",
        inboundAudio,
        ttsAuto: sessionTtsAuto,
      });
      if (shouldRouteToOriginating && originatingChannel && originatingTo) {
        // Route final reply to originating channel.
        const result = await routeReply({
          payload: ttsReply,
          channel: originatingChannel,
          to: originatingTo,
          sessionKey: ctx.SessionKey,
          accountId: ctx.AccountId,
          threadId: ctx.MessageThreadId,
          cfg,
          isGroup,
          groupId,
        });
        if (!result.ok) {
          logVerbose(
            `dispatch-from-config: route-reply (final) failed: ${result.error ?? "unknown error"}`,
          );
        }
        queuedFinal = result.ok || queuedFinal;
        if (result.ok) {
          routedFinalCount += 1;
        }
      } else {
        queuedFinal = dispatcher.sendFinalReply(ttsReply) || queuedFinal;
      }
    }

    const ttsMode = resolveTtsConfig(cfg).mode ?? "final";
    // Generate TTS-only reply after block streaming completes (when there's no final reply).
    // This handles the case where block streaming succeeds and drops final payloads,
    // but we still want TTS audio to be generated from the accumulated block content.
    if (
      ttsMode === "final" &&
      replies.length === 0 &&
      blockCount > 0 &&
      accumulatedBlockText.trim()
    ) {
      try {
        const ttsSyntheticReply = await maybeApplyTtsToPayload({
          payload: { text: accumulatedBlockText },
          cfg,
          channel: ttsChannel,
          kind: "final",
          inboundAudio,
          ttsAuto: sessionTtsAuto,
        });
        // Only send if TTS was actually applied (mediaUrl exists)
        if (ttsSyntheticReply.mediaUrl) {
          // Send TTS-only payload (no text, just audio) so it doesn't duplicate the block content
          const ttsOnlyPayload: ReplyPayload = {
            mediaUrl: ttsSyntheticReply.mediaUrl,
            audioAsVoice: ttsSyntheticReply.audioAsVoice,
          };
          if (shouldRouteToOriginating && originatingChannel && originatingTo) {
            const result = await routeReply({
              payload: ttsOnlyPayload,
              channel: originatingChannel,
              to: originatingTo,
              sessionKey: ctx.SessionKey,
              accountId: ctx.AccountId,
              threadId: ctx.MessageThreadId,
              cfg,
              isGroup,
              groupId,
            });
            queuedFinal = result.ok || queuedFinal;
            if (result.ok) {
              routedFinalCount += 1;
            }
            if (!result.ok) {
              logVerbose(
                `dispatch-from-config: route-reply (tts-only) failed: ${result.error ?? "unknown error"}`,
              );
            }
          } else {
            const didQueue = dispatcher.sendFinalReply(ttsOnlyPayload);
            queuedFinal = didQueue || queuedFinal;
          }
        }
      } catch (err) {
        logVerbose(
          `dispatch-from-config: accumulated block TTS failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    const counts = dispatcher.getQueuedCounts();
    counts.final += routedFinalCount;
    recordProcessed("completed");
    markIdle("message_completed");
    return { queuedFinal, counts };
  } catch (err) {
    recordProcessed("error", { error: String(err) });
    markIdle("message_error");
    throw err;
  }
}
