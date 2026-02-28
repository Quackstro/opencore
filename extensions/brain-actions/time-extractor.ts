/**
 * Brain Actions — Time Extractor.
 *
 * LLM-based extraction of time information from natural language.
 */

import type { ClassificationResult } from "@openclaw/brain-core";
import type { TimeExtraction, ActionRouterConfig } from "./types.js";

// ============================================================================
// LLM Time Extraction
// ============================================================================

/**
 * Extract time information from a thought using LLM.
 * Returns null if no actionable time can be determined.
 */
export async function extractTime(
  rawText: string,
  classification: ClassificationResult,
  config: ActionRouterConfig,
): Promise<TimeExtraction | null> {
  const gatewayUrl = config.gatewayUrl ?? "http://127.0.0.1:18789";
  const model = config.extractionModel ?? "claude-haiku-3.5";
  const timezone = config.timezone ?? "America/New_York";
  const defaultTime = config.reminder?.defaultTime ?? "09:00";
  const now = new Date().toISOString();

  const prompt = `You are a time extraction engine. Given a thought/note and its classification, extract the exact reminder time.

Current date/time (UTC): ${now}
User timezone: ${timezone}

Rules:
- Return the reminder time in the USER's timezone (not UTC)
- "noon" = 12:00, "midnight" = 00:00
- "tomorrow" = next calendar day in user timezone
- "Monday", "Tuesday" etc. = next occurrence of that day
- "every Monday" = recurring (return cron expression in 5-field format)
- If no specific time but a date is given, default to ${defaultTime}
- If the text says "today" with no specific time, do NOT create a reminder (return null)
- Extract WHAT to remind about (strip "remind me" prefix, keep the action)

Thought: "${rawText}"

Classification:
- Urgency: ${classification.urgency}
- Date entities: ${JSON.stringify(classification.entities?.dates ?? [])}
- Follow-up date: ${classification.followUpDate ?? "none"}
- Title: ${classification.title}

OUTPUT (JSON only, no markdown fences):
{
  "date": "YYYY-MM-DD or null",
  "time": "HH:MM or null",
  "timezone": "${timezone}",
  "recurring": null or "cron expression (5-field)",
  "reminderText": "what to remind about"
}`;

  try {
    const response = await fetch(`${gatewayUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.gatewayToken}`,
      },
      body: JSON.stringify({
        model,
        max_tokens: 256,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      console.error(
        `[brain-actions] Time extraction failed: ${response.status} ${body.slice(0, 300)}`,
      );
      return null;
    }

    const data = (await response.json()) as any;
    const textContent = data.choices?.[0]?.message?.content;
    if (!textContent) {
      console.error("[brain-actions] No text in LLM response");
      return null;
    }

    // Parse JSON from response
    const parsed = parseJsonFromLlm(textContent);
    if (!parsed || (!parsed.date && !parsed.recurring)) {
      return null;
    }

    return {
      date: parsed.date ?? null,
      time: parsed.time ?? null,
      timezone: parsed.timezone ?? timezone,
      recurring: parsed.recurring ?? null,
      reminderText: parsed.reminderText ?? classification.title,
    };
  } catch (err) {
    console.error("[brain-actions] Time extraction error:", err);
    return null;
  }
}

/**
 * Parse JSON from LLM response, handling markdown fences.
 */
function parseJsonFromLlm(text: string): any {
  let jsonStr = text
    .replace(/^```(?:json)?\s*\n?/m, "")
    .replace(/\n?```\s*$/m, "")
    .trim();

  // Extract JSON object
  const startIdx = jsonStr.indexOf("{");
  if (startIdx >= 0) {
    let depth = 0;
    let endIdx = startIdx;
    for (let i = startIdx; i < jsonStr.length; i++) {
      if (jsonStr[i] === "{") depth++;
      else if (jsonStr[i] === "}") depth--;
      if (depth === 0) {
        endIdx = i;
        break;
      }
    }
    jsonStr = jsonStr.slice(startIdx, endIdx + 1);
  }

  try {
    return JSON.parse(jsonStr);
  } catch {
    console.error(`[brain-actions] Failed to parse JSON: ${jsonStr.slice(0, 200)}`);
    return null;
  }
}

// ============================================================================
// Timezone Helpers
// ============================================================================

/**
 * Convert local date/time to UTC milliseconds.
 */
export function localToUtcMs(dateStr: string, timeStr: string, timezone: string): number {
  const [year, month, day] = dateStr.split("-").map(Number);
  const [hour, minute] = timeStr.split(":").map(Number);

  // Create a UTC guess
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, 0, 0);

  // Get timezone offset
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  const parts = formatter.formatToParts(new Date(utcGuess));
  const getPart = (type: string) => parseInt(parts.find((p) => p.type === type)?.value ?? "0");

  const tzHour = getPart("hour") === 24 ? 0 : getPart("hour");
  const tzTimeUtc = Date.UTC(
    getPart("year"),
    getPart("month") - 1,
    getPart("day"),
    tzHour,
    getPart("minute"),
    0,
    0,
  );

  const offset = tzTimeUtc - utcGuess;
  return utcGuess - offset;
}

/**
 * Check if extraction is in the past.
 */
export function isInPast(extraction: TimeExtraction, timezone: string): boolean {
  if (extraction.recurring) return false;
  if (!extraction.date) return true;

  const time = extraction.time ?? "09:00";
  const utcMs = localToUtcMs(extraction.date, time, extraction.timezone || timezone);
  return utcMs <= Date.now();
}

/**
 * Format extraction for display.
 */
export function formatExtraction(extraction: TimeExtraction, timezone: string): string {
  if (extraction.recurring) {
    return `recurring (${extraction.recurring})`;
  }
  return `${extraction.date ?? "unknown"} ${extraction.time ?? "09:00"} ${extraction.timezone || timezone}`;
}
