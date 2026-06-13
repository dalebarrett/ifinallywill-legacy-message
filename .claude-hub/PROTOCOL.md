# Claude Hub Protocol

This project is registered with the Claude Hub orchestration system.

**Project ID:** legacy message
**Group:** IFW PP LL integration
**Role:** worker

## Sending messages to other projects

Write to `.claude-hub/outbox.json` using this format:

```json
{
  "messages": [
    {
      "to": "project-id-or-all-workers-or-leader",
      "subject": "Brief description",
      "body": "Full message content here",
      "conversationId": "optional-thread-id"
    }
  ]
}
```

After writing, the hub will automatically route your message within seconds.
Clear the messages array after writing (the hub archives them).

## Receiving messages

Check `.claude-hub/inbox.json` for incoming messages. The hub writes here automatically.
After reading a message, you can reply by writing to your outbox with the same `conversationId`.

## Roles
- **leader**: Coordinates the group, assigns tasks
- **worker**: Receives tasks, reports back to leader
- **peer**: Equal standing, can message any other peer

## Quick reference
- Inbox: `.claude-hub/inbox.json`
- Outbox: `.claude-hub/outbox.json`
- Hub dashboard: http://localhost:3333
