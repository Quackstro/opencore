# Plugin API Extensions

OpenCore extends the upstream OpenClaw plugin system with additional APIs for richer plugin interactions.

## Callback Handlers

Plugins can register handlers for inline button callbacks:

```typescript
registerCallbackHandler("my-prefix", async (callbackData, context) => {
  // Handle button tap
  return { text: "Action completed!" };
});
```

## Message Handlers

Plugins can intercept and process messages before they reach the AI:

```typescript
registerMessageHandler(async (message, context) => {
  if (message.startsWith("/mycommand")) {
    return { handled: true, reply: "Custom response" };
  }
  return { handled: false };
});
```

## Enhanced Command Context

Plugin command handlers receive additional context:

- `chatId` — Channel-specific chat identifier
- `messageId` — Message ID for replies/edits
- `accountId` — Multi-account disambiguation

## URL Button Support

Plugins can include URL buttons in their responses:

```typescript
return {
  text: "Check this out",
  buttons: [[{ text: "Open Link", url: "https://example.com" }]],
};
```
