#!/usr/bin/env node
// Claude Hub inbox notification hook — runs on every UserPromptSubmit
const fs = require('fs');
const path = require('path');
try {
  const inboxFile = path.join(process.cwd(), '.claude-hub', 'inbox.json');
  const inbox = JSON.parse(fs.readFileSync(inboxFile, 'utf8'));
  const unread = inbox.messages.filter(m => !m.read);
  if (unread.length > 0) {
    const lines = [
      `\n[Claude Hub] You have ${unread.length} unread message(s) in your inbox (.claude-hub/inbox.json):`
    ];
    for (const m of unread.slice(0, 5)) {
      lines.push(`  • From ${m.fromName || m.from}: "${m.subject}" (thread: ${m.conversationId?.slice(0,8)})`);
    }
    if (unread.length > 5) lines.push(`  ... and ${unread.length - 5} more`);
    lines.push('Please read and respond to these messages before proceeding with other work.\n');
    process.stdout.write(lines.join('\n'));
  }
} catch {}
// Exit 0 = allow the prompt to continue
process.exit(0);
