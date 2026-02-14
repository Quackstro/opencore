# Phone Plugin

AI-powered outbound phone calls via Twilio and OpenAI Realtime API.

## Features

- **Natural Conversations**: Uses OpenAI's Realtime API for fluid, natural voice conversations
- **Task-Oriented Calls**: Define what the AI should accomplish on each call
- **Automatic Transcription**: Full transcripts saved for every call
- **Voicemail Detection**: Detects answering machines and leaves appropriate messages
- **Call History**: Track past calls with outcomes and transcripts

## Configuration

Add to your `config.yaml`:

```yaml
plugins:
  phone:
    enabled: true
    provider: twilio
    accountSid: ${TWILIO_ACCOUNT_SID}
    authToken: ${TWILIO_AUTH_TOKEN}
    phoneNumber: "+1XXXXXXXXXX" # Your Twilio phone number
    openaiApiKey: ${OPENAI_API_KEY} # Optional, falls back to env var
    realtimeModel: "gpt-4o-realtime-preview-2024-12-17"
    defaultVoice: "alloy"
    maxCallDuration: 600 # 10 min max
    recordCalls: true
    transcriptsDir: "~/.openclaw/phone/transcripts"
    webhookPort: 18790
    webhookHost: "https://your-domain.com" # Public URL for Twilio webhooks
```

### Environment Variables

- `TWILIO_ACCOUNT_SID` - Twilio Account SID
- `TWILIO_AUTH_TOKEN` - Twilio Auth Token
- `OPENAI_API_KEY` - OpenAI API Key (if not set in config)

### Webhook Setup

The plugin runs a local webhook server for Twilio callbacks. For production use:

1. Expose the webhook port (default: 18790) to the internet
2. Set `webhookHost` to your public URL
3. Ensure your firewall allows inbound connections

For local development, use ngrok:

```bash
ngrok http 18790
```

Then set `webhookHost` to the ngrok URL.

## Tools

### phone_call

Make an outbound call with an AI agent.

```
phone_call(
  to: "+15551234567",
  task: "Schedule an appointment for next Tuesday at 2pm",
  context: "Speaking with Dr. Smith's office, patient name is John Doe"
)
```

**Parameters:**

- `to` (required): Phone number to call (E.164 or 10-digit US)
- `task` (required): What the AI should accomplish
- `context` (optional): Additional context to help the AI

**Returns:**

- Call status (completed, failed, busy, no-answer, etc.)
- Full transcript
- Outcome summary
- Next steps (if any)

### phone_status

Check the status of an ongoing or recent call.

```
phone_status(callId: "abc12345")
```

### phone_history

Get past call transcripts and outcomes.

```
phone_history(limit: 10)
phone_history(callId: "abc12345")  # Get specific call
```

## Call Flow

1. Agent triggers `phone_call` tool with task description
2. Plugin initiates Twilio outbound call
3. Twilio connects to the webhook server
4. Plugin establishes WebSocket connection for media streaming
5. Audio streams bidirectionally between Twilio and OpenAI Realtime API
6. AI conducts natural conversation based on the task
7. AI calls `end_call` function when task is complete (or transfers if needed)
8. Transcript is saved, outcome returned to agent

## Voice Options

Available voices for `defaultVoice`:

- `alloy` - Neutral, balanced
- `echo` - Soft, gentle
- `shimmer` - Clear, expressive
- `ash` - Warm, friendly (default for male)
- `ballad` - Melodic, soothing
- `coral` - Bright, energetic
- `sage` - Calm, wise
- `verse` - Dynamic, engaging

## Error Handling

The plugin handles:

- **Call failures**: Network issues, invalid numbers
- **No answer**: Times out after 30 seconds
- **Busy signal**: Reports busy status
- **Voicemail**: Detects machines and leaves messages
- **API rate limits**: Graceful degradation
- **Max duration**: Enforces call time limits

## Transcripts

Transcripts are saved to `transcriptsDir` as JSON files:

```json
{
  "id": "abc12345",
  "to": "+15551234567",
  "task": "Schedule an appointment...",
  "status": "completed",
  "startedAt": "2024-01-15T10:30:00Z",
  "endedAt": "2024-01-15T10:35:42Z",
  "duration": 342,
  "transcript": [
    { "timestamp": "...", "role": "assistant", "text": "Hello..." },
    { "timestamp": "...", "role": "user", "text": "Hi, how can I help?" }
  ],
  "outcome": {
    "success": true,
    "taskCompleted": true,
    "summary": "Appointment scheduled for Tuesday at 2pm",
    "nextSteps": ["Confirm via email"]
  }
}
```

## Architecture

```
┌─────────────┐     ┌──────────────┐     ┌─────────────────┐
│   Agent     │────▶│ Phone Plugin │────▶│ Twilio REST API │
│ (phone_call)│     │              │     │  (initiate call) │
└─────────────┘     └──────────────┘     └─────────────────┘
                           │
                           ▼
                    ┌──────────────┐     ┌─────────────────┐
                    │ WebSocket    │◀───▶│ Twilio Media    │
                    │ Server       │     │ Streams         │
                    └──────────────┘     └─────────────────┘
                           │
                           ▼
                    ┌──────────────┐     ┌─────────────────┐
                    │ Realtime     │◀───▶│ OpenAI Realtime │
                    │ Handler      │     │ API (WebSocket) │
                    └──────────────┘     └─────────────────┘
```

## References

- [Twilio Media Streams](https://www.twilio.com/docs/voice/media-streams)
- [OpenAI Realtime API](https://platform.openai.com/docs/guides/realtime)
- [Twilio Voice TwiML](https://www.twilio.com/docs/voice/twiml)
