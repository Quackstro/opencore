/**
 * Parse inline button directives from agent reply text.
 *
 * Syntax (one or more rows):
 *   [[buttons: Label1:/callback1, Label2:/callback2]]
 *   [[buttons: Label3:/callback3 | style:danger]]
 *
 * Each [[buttons: ...]] block becomes one row of inline buttons.
 * Directives are stripped from the text and attached as channelData.
 */

import type { ReplyPayload } from "../types.js";

interface InlineButton {
  text: string;
  callback_data: string;
  style?: "primary" | "success" | "danger";
}

const BUTTONS_RE = /\[\[buttons?:\s*([^\]]+)\]\]/gi;

function parseButtonRow(raw: string): InlineButton[] {
  // Split on comma, but respect escaped commas
  const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const buttons: InlineButton[] = [];

  for (const part of parts) {
    // Format: "Label:/callback" or "Label:/callback | style:danger"
    const styleSplit = part.split("|").map((s) => s.trim());
    const main = styleSplit[0];
    const stylePart = styleSplit[1];

    const colonIdx = main.lastIndexOf(":");
    if (colonIdx === -1) continue;

    const label = main.slice(0, colonIdx).trim();
    const callbackData = main.slice(colonIdx + 1).trim();
    if (!label || !callbackData) continue;

    const btn: InlineButton = { text: label, callback_data: callbackData };

    if (stylePart) {
      const styleMatch = stylePart.match(/style:\s*(primary|success|danger)/i);
      if (styleMatch) {
        btn.style = styleMatch[1].toLowerCase() as InlineButton["style"];
      }
    }

    buttons.push(btn);
  }

  return buttons;
}

export function hasInlineButtonDirectives(text: string): boolean {
  return BUTTONS_RE.test(text);
}

export function parseInlineButtonDirectives(payload: ReplyPayload): ReplyPayload {
  if (!payload.text) return payload;

  // Reset lastIndex since we tested with the same regex
  BUTTONS_RE.lastIndex = 0;

  const rows: InlineButton[][] = [];
  let text = payload.text;

  let match: RegExpExecArray | null;
  // Collect all matches first, then replace
  const matches: RegExpExecArray[] = [];
  while ((match = BUTTONS_RE.exec(payload.text)) !== null) {
    matches.push(match);
  }

  for (const m of matches) {
    const row = parseButtonRow(m[1]);
    if (row.length > 0) {
      rows.push(row);
    }
    text = text.replace(m[0], "");
  }

  if (rows.length === 0) return payload;

  // Auto-stack: if a single row has buttons whose labels are too long,
  // split into one button per row for readability.
  const AUTO_STACK_CHAR_THRESHOLD = 30; // total chars across all labels in a row
  const finalRows: InlineButton[][] = [];
  for (const row of rows) {
    const totalLabelChars = row.reduce((sum, b) => sum + b.text.length, 0);
    if (row.length > 1 && totalLabelChars > AUTO_STACK_CHAR_THRESHOLD) {
      // Stack each button into its own row
      for (const btn of row) {
        finalRows.push([btn]);
      }
    } else {
      finalRows.push(row);
    }
  }
  rows.length = 0;
  rows.push(...finalRows);

  text = text.trim();

  const existing = (payload.channelData ?? {}) as Record<string, unknown>;
  const existingTelegram = (existing.telegram ?? {}) as Record<string, unknown>;

  return {
    ...payload,
    text,
    channelData: {
      ...existing,
      telegram: {
        ...existingTelegram,
        buttons: rows,
      },
    },
  };
}
