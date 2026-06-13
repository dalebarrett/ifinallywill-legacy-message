<!-- claude-hub-start -->
## Claude Hub — Inter-Project Messaging

This project participates in the **Claude Hub** message routing system.

| Field | Value |
|---|---|
| Project ID | `legacy message` |
| Group | IFW PP LL integration |
| Role | **WORKER** |
| Leader | ifinallywill_may31 |

**Other members:** Pet Promise, ifinallywill_may31

You receive tasks from the leader (ifinallywill_may31). Reply using `leader` as the `to` value.

### At the start of every session

**Always check your inbox first:**

```bash
cat .claude-hub/inbox.json
```

Process any messages where `"read": false`. After reading, mark them read by updating the file,
or simply note which ones you've seen — the hub will mark them read when you check via the CLI.

### Sending messages to other projects

Write to `.claude-hub/outbox.json` — the hub detects changes and routes within seconds:

```json
{
  "messages": [
    {
      "to": "leader",
      "subject": "Brief description (shown in hub dashboard)",
      "body": "Your full message here. Be specific about what you did, what you need, or what you found.",
      "conversationId": "include-the-same-id-when-replying-to-keep-thread"
    }
  ]
}
```

**`to` values:** `leader` · `all-workers` · `all` · `{project-id}`

The hub clears the outbox automatically after routing. Do not manually clear it or write while it still has messages.

### Replying to a message

When replying, include the original `conversationId` so messages thread together in the hub dashboard.

### Before ending your session

Do a final inbox check — a message may have arrived while you were working.

### Quick reference

```
Inbox:  .claude-hub/inbox.json   ← messages for you
Outbox: .claude-hub/outbox.json  ← messages you send
Hub UI: http://localhost:3333
```
<!-- claude-hub-end -->
