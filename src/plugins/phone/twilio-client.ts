/**
 * Phone Plugin — Twilio Client
 *
 * Wrapper for Twilio API to initiate and manage outbound calls.
 */

import type { PhonePluginConfig, TwilioCallOptions, CallState, PhoneLogger } from "./types.js";

// =============================================================================
// Twilio REST Client
// =============================================================================

export class TwilioClient {
  private accountSid: string;
  private authToken: string;
  private phoneNumber: string;
  private baseUrl: string;
  private logger: PhoneLogger;

  constructor(config: PhonePluginConfig, logger: PhoneLogger) {
    this.accountSid = config.accountSid;
    this.authToken = config.authToken;
    this.phoneNumber = config.phoneNumber;
    this.baseUrl = `https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}`;
    this.logger = logger;
  }

  /**
   * Create Basic Auth header for Twilio API requests.
   */
  private getAuthHeader(): string {
    const credentials = Buffer.from(`${this.accountSid}:${this.authToken}`).toString("base64");
    return `Basic ${credentials}`;
  }

  /**
   * Make an outbound call via Twilio.
   */
  async initiateCall(options: TwilioCallOptions): Promise<{ callSid: string; status: string }> {
    const url = `${this.baseUrl}/Calls.json`;

    const body = new URLSearchParams({
      To: options.to,
      From: options.from,
      Url: options.url,
    });

    if (options.statusCallback) {
      body.append("StatusCallback", options.statusCallback);
      body.append("StatusCallbackMethod", options.statusCallbackMethod ?? "POST");
    }

    if (options.statusCallbackEvent) {
      for (const event of options.statusCallbackEvent) {
        body.append("StatusCallbackEvent", event);
      }
    }

    if (options.timeout) {
      body.append("Timeout", String(options.timeout));
    }

    if (options.record) {
      body.append("Record", "true");
    }

    if (options.machineDetection) {
      body.append("MachineDetection", options.machineDetection);
      body.append("AsyncAmd", "true");
      body.append("AsyncAmdStatusCallback", options.statusCallback ?? options.url);
    }

    this.logger.info(`phone: initiating call to ${options.to}`);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: this.getAuthHeader(),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });

    if (!response.ok) {
      const errorText = await response.text();
      this.logger.error(`phone: Twilio call initiation failed: ${response.status} ${errorText}`);
      throw new Error(`Twilio API error: ${response.status} ${errorText.slice(0, 200)}`);
    }

    const data = (await response.json()) as { sid: string; status: string };
    this.logger.info(`phone: call initiated, SID: ${data.sid}, status: ${data.status}`);

    return {
      callSid: data.sid,
      status: data.status,
    };
  }

  /**
   * Get call status from Twilio.
   */
  async getCallStatus(callSid: string): Promise<{
    status: string;
    duration?: number;
    answeredBy?: string;
  }> {
    const url = `${this.baseUrl}/Calls/${callSid}.json`;

    const response = await fetch(url, {
      headers: {
        Authorization: this.getAuthHeader(),
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Twilio API error: ${response.status} ${errorText.slice(0, 200)}`);
    }

    const data = (await response.json()) as {
      status: string;
      duration?: string;
      answered_by?: string;
    };

    return {
      status: data.status,
      duration: data.duration ? parseInt(data.duration) : undefined,
      answeredBy: data.answered_by,
    };
  }

  /**
   * Hang up an active call.
   */
  async hangup(callSid: string): Promise<void> {
    const url = `${this.baseUrl}/Calls/${callSid}.json`;

    const body = new URLSearchParams({
      Status: "completed",
    });

    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: this.getAuthHeader(),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });

    if (!response.ok) {
      const errorText = await response.text();
      this.logger.error(`phone: failed to hang up call ${callSid}: ${errorText}`);
      throw new Error(`Twilio API error: ${response.status}`);
    }

    this.logger.info(`phone: call ${callSid} hung up`);
  }

  /**
   * Get call recordings.
   */
  async getRecordings(
    callSid: string,
  ): Promise<Array<{ sid: string; uri: string; duration: number }>> {
    const url = `${this.baseUrl}/Calls/${callSid}/Recordings.json`;

    const response = await fetch(url, {
      headers: {
        Authorization: this.getAuthHeader(),
      },
    });

    if (!response.ok) {
      return [];
    }

    const data = (await response.json()) as {
      recordings: Array<{ sid: string; uri: string; duration: string }>;
    };

    return (data.recordings ?? []).map((r) => ({
      sid: r.sid,
      uri: `https://api.twilio.com${r.uri.replace(".json", ".mp3")}`,
      duration: parseInt(r.duration),
    }));
  }

  /**
   * Validate Twilio webhook signature (X-Twilio-Signature header).
   */
  validateWebhookSignature(
    signature: string,
    url: string,
    params: Record<string, string>,
  ): boolean {
    const crypto = require("crypto") as typeof import("crypto");

    // Sort params alphabetically and concatenate
    const sortedKeys = Object.keys(params).toSorted();
    let dataString = url;
    for (const key of sortedKeys) {
      dataString += key + params[key];
    }

    // Create HMAC-SHA1 hash
    const expectedSignature = crypto
      .createHmac("sha1", this.authToken)
      .update(dataString)
      .digest("base64");

    return signature === expectedSignature;
  }

  /**
   * Generate TwiML for WebSocket media streaming.
   */
  generateStreamTwiML(params: { wsUrl: string; callId: string; greeting?: string }): string {
    // Optional greeting before connecting
    const sayBlock = params.greeting
      ? `<Say voice="Polly.Matthew">${escapeXml(params.greeting)}</Say>`
      : "";

    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${sayBlock}
  <Connect>
    <Stream url="${escapeXml(params.wsUrl)}">
      <Parameter name="callId" value="${escapeXml(params.callId)}" />
    </Stream>
  </Connect>
</Response>`;
  }

  /**
   * Generate simple TwiML response.
   */
  generateTwiML(content: { say?: string; hangup?: boolean }): string {
    let body = "";
    if (content.say) {
      body += `<Say voice="Polly.Matthew">${escapeXml(content.say)}</Say>`;
    }
    if (content.hangup) {
      body += "<Hangup/>";
    }
    return `<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`;
  }

  /**
   * Get the from phone number.
   */
  getPhoneNumber(): string {
    return this.phoneNumber;
  }
}

/**
 * Escape XML special characters.
 */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
