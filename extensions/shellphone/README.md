# 🐚 Shellphone

> _"Can you hear me now?"_ — A crab, probably

Voice calls from the deep, using open-source components instead of proprietary APIs.

## Features

- **🐋 Whisper STT** - Listens like a whale (via faster-whisper)
- **🧜 Piper TTS** - Speaks like a siren (fast, natural, local)
- **🐙 Any LLM** - Thinks like an octopus (uses OpenCore's configured model)
- **📞 Twilio** - Surfaces calls to the human world
- **🔓 No Vendor Lock-in** - All AI components are local and open-source

## Architecture

```
                           🌊 THE SURFACE 🌊
┌─────────────────────────────────────────────────────────────────────┐
│                         Twilio Media Stream                          │
│                              (mu-law 8kHz)                           │
└───────────────────┬─────────────────────────────────────┬───────────┘
                    │                                     │
                    ▼                                     ▲
         ┌──────────────────┐               ┌──────────────────┐
         │  🦀 Voice Activity │               │   🔊 Audio Output  │
         │     Detection     │               │   (mu-law 8kHz)  │
         │  (Energy-based)   │               │                  │
         └────────┬─────────┘               └────────┬─────────┘
                  │                                  │
                  ▼                                  │
         ┌──────────────────┐               ┌──────────────────┐
         │  🐋 Whisper STT   │               │   🧜 Piper TTS    │
         │ (faster-whisper) │               │  (or Edge TTS)   │
         │   PCM 16kHz      │               │   PCM → mu-law   │
         └────────┬─────────┘               └────────┬─────────┘
                  │                                  │
                  ▼                                  │
         ┌──────────────────┐               ┌──────────────────┐
         │   📝 Transcript   │               │    💬 Response    │
         │                  │──────────────▶│                  │
         └────────┬─────────┘               └────────┬─────────┘
                  │                                  ▲
                  ▼                                  │
         ┌───────────────────────────────────────────┴───────────────┐
         │                    🐙 OpenCore LLM                         │
         │               (Any configured provider)                    │
         └───────────────────────────────────────────────────────────┘
                           🌊 THE DEEP 🌊
```

## Installation

### 1. Install Dependencies

```bash
# Install Whisper STT (the whale's ears)
./scripts/install-whisper.sh base  # or: tiny, small, medium, large

# Install Piper TTS (the siren's voice)
./scripts/install-piper.sh en_US-amy-medium  # or any other voice
```

### 2. Copy to Extensions

```bash
cp -R extensions/shellphone ~/.openclaw/extensions/
```

### 3. Configure

Add to your `openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "shellphone": {
        "enabled": true,
        "provider": "twilio",
        "fromNumber": "+15550001234",
        "toNumber": "+15550005678",
        "twilio": {
          "accountSid": "ACxxxxxxxxxx",
          "authToken": "your-auth-token"
        },
        "stt": {
          "whisper": {
            "model": "base",
            "device": "cpu"
          }
        },
        "tts": {
          "provider": "piper",
          "piper": {
            "model": "en_US-amy-medium",
            "dataDir": "~/.openclaw/piper"
          }
        }
      }
    }
  }
}
```

## Usage

### Tool (Agent)

The plugin registers a `shellphone` tool:

```javascript
// 📞 Make a call
shellphone({
  action: "call",
  to: "+15550001234",
  message: "Ahoy! This is your friendly neighborhood crab.",
  mode: "conversation", // or "notify" for one-way messages
});

// 🗣️ Speak on an active call
shellphone({
  action: "speak",
  callId: "uuid-here",
  message: "The treasure is buried under the third palm tree.",
});

// 📴 Hang up
shellphone({
  action: "hangup",
  callId: "uuid-here",
});

// 📊 Check status
shellphone({
  action: "status",
  callId: "uuid-here", // omit for plugin status
});
```

### CLI

```bash
# Make a call
openclaw shellphone call +15550001234 --message "Ahoy!"

# Check status
openclaw shellphone status <call-id>

# Hang up
openclaw shellphone hangup <call-id>
```

## Configuration Reference

### Core Settings

| Setting      | Type    | Default  | Description                             |
| ------------ | ------- | -------- | --------------------------------------- |
| `enabled`    | boolean | `false`  | Awaken the shell                        |
| `provider`   | string  | `"mock"` | Telephony provider (`twilio` or `mock`) |
| `fromNumber` | string  | -        | E.164 phone number to call from         |
| `toNumber`   | string  | -        | Default E.164 phone number to call      |

### STT (Whisper) Settings

| Setting                | Type   | Default  | Description                                  |
| ---------------------- | ------ | -------- | -------------------------------------------- |
| `stt.whisper.model`    | string | `"base"` | Model size: tiny, base, small, medium, large |
| `stt.whisper.device`   | string | `"cpu"`  | Device: cpu or cuda                          |
| `stt.whisper.language` | string | `"en"`   | ISO language code                            |

### TTS Settings

| Setting                 | Type   | Default               | Description                  |
| ----------------------- | ------ | --------------------- | ---------------------------- |
| `tts.provider`          | string | `"piper"`             | TTS provider: piper or edge  |
| `tts.piper.model`       | string | `"en_US-amy-medium"`  | Piper voice model            |
| `tts.piper.dataDir`     | string | `"~/.openclaw/piper"` | Piper models directory       |
| `tts.piper.lengthScale` | number | `1.0`                 | Speech rate (lower = faster) |
| `tts.edge.voice`        | string | `"en-US-AriaNeural"`  | Edge TTS voice               |

### VAD Settings

| Setting                  | Type   | Default | Description                    |
| ------------------------ | ------ | ------- | ------------------------------ |
| `vad.silenceThresholdMs` | number | `500`   | Silence duration to end speech |
| `vad.minSpeechMs`        | number | `100`   | Minimum speech duration        |
| `vad.energyThreshold`    | number | `0.01`  | RMS energy threshold           |

## Whisper Models

| Model    | Size | Speed  | Quality    | Use Case             |
| -------- | ---- | ------ | ---------- | -------------------- |
| `tiny`   | 39M  | 🚀🚀🚀 | ⭐⭐       | Testing, quick demos |
| `base`   | 74M  | 🚀🚀   | ⭐⭐⭐     | **Recommended**      |
| `small`  | 244M | 🚀     | ⭐⭐⭐⭐   | Higher accuracy      |
| `medium` | 769M | 🐢     | ⭐⭐⭐⭐⭐ | Non-real-time        |
| `large`  | 1.5G | 🐌     | ⭐⭐⭐⭐⭐ | Maximum accuracy     |

## Piper Voices

Popular English voices (the siren's repertoire):

- `en_US-amy-medium` - American female, natural 🧜‍♀️
- `en_US-lessac-medium` - American male, clear 🧜‍♂️
- `en_GB-alan-medium` - British male 🎩
- `en_GB-cori-medium` - British female ☕

Browse all voices: https://rhasspy.github.io/piper-samples/

## Latency

Target: **3-5 seconds per turn** (batch processing, not real-time streaming)

| Component        | Typical Time |
| ---------------- | ------------ |
| 🦀 VAD/Buffering | 500ms        |
| 🐋 Whisper STT   | 1-2s         |
| 🐙 LLM Response  | 0.5-1.5s     |
| 🧜 Piper TTS     | 0.3-0.5s     |
| 🌊 Network       | 0.2-0.5s     |

## Troubleshooting

### 🐋 Whisper not found

```bash
pip install faster-whisper
```

### 🧜 Piper not found

```bash
./scripts/install-piper.sh
export PATH="${HOME}/.local/bin:$PATH"
```

### 🔇 No audio output

1. Check Twilio webhook URL is publicly accessible
2. Verify ngrok tunnel is running
3. Check Twilio console for errors

### 📝 Poor transcription

1. Try a larger Whisper model
2. Check audio quality from Twilio
3. Adjust VAD settings

## Development

```bash
cd extensions/shellphone
pnpm test
```

## Project Structure

```
shellphone/
├── index.ts              # 🐚 Plugin entry
├── src/
│   ├── types.ts          # Type definitions
│   ├── audio-utils.ts    # Audio format conversion
│   ├── pipeline.ts       # VAD → STT → LLM → TTS
│   ├── runtime.ts        # Webhook server, Twilio
│   ├── stt/
│   │   ├── vad.ts        # 🦀 Voice activity detection
│   │   └── whisper.ts    # 🐋 Whisper integration
│   └── tts/
│       ├── piper.ts      # 🧜 Piper integration
│       └── edge.ts       # Edge TTS fallback
├── tests/                # 51 tests
└── scripts/
    ├── install-whisper.sh
    └── install-piper.sh
```

## License

MIT

## Credits

- [faster-whisper](https://github.com/guillaumekln/faster-whisper) - The whale's ears
- [Piper](https://github.com/rhasspy/piper) - The siren's voice
- [OpenClaw](https://github.com/openclaw/openclaw) - The octopus brain

---

_Made with 🦀 in the depths_
