/**
 * Log Monitor Diagnostic Event Collector
 *
 * Subscribes to real-time diagnostic events (session.stuck, webhook.error,
 * message.processed with error outcome) and converts them into issues
 * for the log monitor registry — without needing to parse log files.
 */

import type {
  DiagnosticEventPayload,
  DiagnosticMessageProcessedEvent,
  DiagnosticSessionStuckEvent,
  DiagnosticWebhookErrorEvent,
} from "./diagnostic-events.js";
import type { IssueCategory } from "./log-monitor-registry.js";
import { onDiagnosticEvent } from "./diagnostic-events.js";

// ============================================================================
// Types
// ============================================================================

export interface DiagnosticIssue {
  signature: string;
  category: IssueCategory;
  message: string;
}

type IssueCallback = (issue: DiagnosticIssue) => void;

// ============================================================================
// Event converters
// ============================================================================

function convertSessionStuck(evt: DiagnosticSessionStuckEvent): DiagnosticIssue {
  const sessionDesc = evt.sessionKey ?? evt.sessionId ?? "unknown";
  return {
    signature: `session.stuck:${sessionDesc}:${evt.state}`,
    category: "stuck-session",
    message: `Session ${sessionDesc} stuck in ${evt.state} state for ${Math.round(evt.ageMs / 1000)}s (queue depth: ${evt.queueDepth ?? 0})`,
  };
}

function convertWebhookError(evt: DiagnosticWebhookErrorEvent): DiagnosticIssue {
  return {
    signature: `webhook.error:${evt.channel}:${evt.updateType ?? "unknown"}`,
    category: "error",
    message: `Webhook error on ${evt.channel}${evt.updateType ? ` (${evt.updateType})` : ""}: ${evt.error}`,
  };
}

function convertMessageError(evt: DiagnosticMessageProcessedEvent): DiagnosticIssue | null {
  if (evt.outcome !== "error") {
    return null;
  }
  return {
    signature: `message.error:${evt.channel}:${evt.error ?? evt.reason ?? "unknown"}`,
    category: "error",
    message: `Message processing error on ${evt.channel}: ${evt.error ?? evt.reason ?? "unknown error"}`,
  };
}

// ============================================================================
// Collector
// ============================================================================

/**
 * Start collecting diagnostic events and feeding them into the registry.
 * @returns A stop function to unsubscribe.
 */
export function startDiagnosticCollector(onIssue: IssueCallback): () => void {
  const unsub = onDiagnosticEvent((evt: DiagnosticEventPayload) => {
    let issue: DiagnosticIssue | null = null;

    switch (evt.type) {
      case "session.stuck":
        issue = convertSessionStuck(evt);
        break;
      case "webhook.error":
        issue = convertWebhookError(evt);
        break;
      case "message.processed":
        issue = convertMessageError(evt);
        break;
      default:
        break;
    }

    if (issue) {
      onIssue(issue);
    }
  });

  return unsub;
}
