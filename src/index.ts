#!/usr/bin/env node
/**
 * proton-mcp — a Model Context Protocol server that lets an LLM read and send
 * email through Proton Mail Bridge.
 *
 * Reading/searching goes over the Bridge's local IMAP server; sending goes over
 * its local SMTP server. See README.md for setup.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ImapFlow, type MailboxObject } from "imapflow";
import nodemailer from "nodemailer";
import { simpleParser, type AddressObject } from "mailparser";
import { z } from "zod";
import { loadConfig } from "./config.js";

const MAX_BODY_CHARS = 50_000;

/* ------------------------------------------------------------------ helpers */

/** Open an IMAP connection, run `fn`, and always log out afterwards. */
async function withImap<T>(fn: (client: ImapFlow) => Promise<T>): Promise<T> {
  const cfg = loadConfig();
  const client = new ImapFlow({
    host: cfg.host,
    port: cfg.imapPort,
    secure: false, // Bridge uses STARTTLS on the IMAP port; imapflow upgrades.
    auth: { user: cfg.username, pass: cfg.password },
    tls: { rejectUnauthorized: cfg.rejectUnauthorized },
    logger: false,
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    try {
      await client.logout();
    } catch {
      /* connection already gone — nothing to do */
    }
  }
}

function formatAddress(addr?: { name?: string; address?: string }): string {
  if (!addr) return "(unknown)";
  if (addr.name && addr.address) return `${addr.name} <${addr.address}>`;
  return addr.address || addr.name || "(unknown)";
}

function formatAddressList(
  list?: Array<{ name?: string; address?: string }>,
): string {
  if (!list || list.length === 0) return "(none)";
  return list.map(formatAddress).join(", ");
}

function parsedAddressText(addr?: AddressObject | AddressObject[]): string {
  if (!addr) return "(none)";
  if (Array.isArray(addr)) return addr.map((a) => a.text).join(", ") || "(none)";
  return addr.text || "(none)";
}

/** One-line summary used in message listings. */
function summarizeEnvelope(
  uid: number,
  envelope: {
    date?: Date;
    subject?: string;
    from?: Array<{ name?: string; address?: string }>;
  },
  seen: boolean,
): string {
  const date = envelope.date ? new Date(envelope.date).toISOString() : "(no date)";
  const flag = seen ? " " : "•"; // bullet marks unread
  return `${flag} uid:${uid}  ${date}  from: ${formatAddressList(
    envelope.from,
  )}  subject: ${envelope.subject || "(no subject)"}`;
}

function text(content: string) {
  return { content: [{ type: "text" as const, text: content }] };
}

function errorText(message: string) {
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

/* ------------------------------------------------------------------- server */

const server = new McpServer({
  name: "proton-mcp",
  version: "0.1.0",
});

server.registerTool(
  "list_mailboxes",
  {
    title: "List mailboxes",
    description:
      "List all IMAP mailboxes/folders in the Proton account, with total and " +
      "unread message counts for each.",
    inputSchema: {},
  },
  async () => {
    return withImap(async (client) => {
      const boxes = await client.list();
      const lines: string[] = [];
      for (const box of boxes) {
        let counts = "";
        try {
          const status = await client.status(box.path, {
            messages: true,
            unseen: true,
          });
          counts = `  (${status.messages ?? 0} messages, ${
            status.unseen ?? 0
          } unread)`;
        } catch {
          /* some special folders cannot be STATUSed */
        }
        const special = box.specialUse ? `  [${box.specialUse}]` : "";
        lines.push(`${box.path}${special}${counts}`);
      }
      return text(
        lines.length ? lines.join("\n") : "No mailboxes found.",
      );
    });
  },
);

server.registerTool(
  "list_messages",
  {
    title: "List messages",
    description:
      "List the most recent messages in a mailbox (newest first). Returns a " +
      "summary line per message including its UID, which is needed to read the " +
      "full message with read_message.",
    inputSchema: {
      mailbox: z
        .string()
        .default("INBOX")
        .describe("Mailbox/folder path, e.g. INBOX, Sent, Archive."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(20)
        .describe("Maximum number of messages to return (1-100)."),
    },
  },
  async ({ mailbox, limit }) => {
    return withImap(async (client) => {
      const lock = await client.getMailboxLock(mailbox);
      try {
        const exists = (client.mailbox as MailboxObject).exists;
        if (!exists) return text(`Mailbox "${mailbox}" is empty.`);
        const start = Math.max(1, exists - limit + 1);
        const rows: string[] = [];
        for await (const msg of client.fetch(`${start}:*`, {
          uid: true,
          envelope: true,
          flags: true,
        })) {
          const seen = msg.flags?.has("\\Seen") ?? false;
          rows.push(summarizeEnvelope(msg.uid, msg.envelope ?? {}, seen));
        }
        rows.reverse(); // newest first
        return text(
          `Mailbox "${mailbox}" — ${exists} total, showing ${rows.length}:\n\n` +
            rows.join("\n"),
        );
      } finally {
        lock.release();
      }
    });
  },
);

server.registerTool(
  "read_message",
  {
    title: "Read message",
    description:
      "Fetch and return the full content of a single message by its UID, " +
      "including headers and the plain-text body. Get UIDs from list_messages " +
      "or search_messages.",
    inputSchema: {
      mailbox: z
        .string()
        .default("INBOX")
        .describe("Mailbox/folder the message lives in."),
      uid: z.number().int().positive().describe("The message UID."),
      mark_seen: z
        .boolean()
        .default(false)
        .describe("Mark the message as read after fetching it."),
    },
  },
  async ({ mailbox, uid, mark_seen }) => {
    return withImap(async (client) => {
      const lock = await client.getMailboxLock(mailbox);
      try {
        const msg = await client.fetchOne(
          String(uid),
          { uid: true, source: true, flags: true },
          { uid: true },
        );
        if (!msg || !msg.source) {
          return errorText(
            `No message with UID ${uid} found in "${mailbox}".`,
          );
        }
        const parsed = await simpleParser(msg.source);
        let body =
          parsed.text ??
          (parsed.html
            ? `(no plain-text part; HTML follows)\n\n${parsed.html}`
            : "(no body)");
        let truncated = "";
        if (body.length > MAX_BODY_CHARS) {
          body = body.slice(0, MAX_BODY_CHARS);
          truncated = `\n\n… [truncated at ${MAX_BODY_CHARS} characters]`;
        }
        const attachments =
          parsed.attachments && parsed.attachments.length
            ? parsed.attachments
                .map(
                  (a) =>
                    `  - ${a.filename ?? "(unnamed)"} (${a.contentType}, ${
                      a.size
                    } bytes)`,
                )
                .join("\n")
            : "  (none)";

        if (mark_seen) {
          await client.messageFlagsAdd(String(uid), ["\\Seen"], { uid: true });
        }

        return text(
          [
            `UID: ${uid}  (mailbox: ${mailbox})`,
            `Date: ${parsed.date ? parsed.date.toISOString() : "(unknown)"}`,
            `From: ${parsedAddressText(parsed.from)}`,
            `To: ${parsedAddressText(parsed.to)}`,
            `Cc: ${parsedAddressText(parsed.cc)}`,
            `Subject: ${parsed.subject ?? "(no subject)"}`,
            `Attachments:\n${attachments}`,
            "",
            "----- body -----",
            body + truncated,
          ].join("\n"),
        );
      } finally {
        lock.release();
      }
    });
  },
);

server.registerTool(
  "search_messages",
  {
    title: "Search messages",
    description:
      "Search a mailbox using IMAP criteria. All provided filters are combined " +
      "with AND. Returns matching message summaries (newest first).",
    inputSchema: {
      mailbox: z.string().default("INBOX").describe("Mailbox/folder to search."),
      from: z.string().optional().describe("Match the From header (substring)."),
      to: z.string().optional().describe("Match the To header (substring)."),
      subject: z
        .string()
        .optional()
        .describe("Match the Subject header (substring)."),
      body: z.string().optional().describe("Match text in the message body."),
      since: z
        .string()
        .optional()
        .describe("Only messages on/after this date (e.g. 2026-05-01)."),
      before: z
        .string()
        .optional()
        .describe("Only messages before this date (e.g. 2026-05-29)."),
      unread_only: z
        .boolean()
        .default(false)
        .describe("Restrict to unread (unseen) messages only."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(25)
        .describe("Maximum number of results (1-100)."),
    },
  },
  async (args) => {
    const { mailbox, from, to, subject, body, since, before, unread_only, limit } =
      args;
    return withImap(async (client) => {
      const lock = await client.getMailboxLock(mailbox);
      try {
        const criteria: Record<string, unknown> = {};
        if (from) criteria.from = from;
        if (to) criteria.to = to;
        if (subject) criteria.subject = subject;
        if (body) criteria.body = body;
        if (unread_only) criteria.seen = false;
        if (since) {
          const d = new Date(since);
          if (Number.isNaN(d.getTime()))
            return errorText(`Invalid "since" date: ${since}`);
          criteria.since = d;
        }
        if (before) {
          const d = new Date(before);
          if (Number.isNaN(d.getTime()))
            return errorText(`Invalid "before" date: ${before}`);
          criteria.before = d;
        }
        if (Object.keys(criteria).length === 0) criteria.all = true;

        const uids = await client.search(criteria, { uid: true });
        if (!uids || uids.length === 0)
          return text(`No messages matched in "${mailbox}".`);

        const selected = uids.slice(-limit); // most recent UIDs
        const rows: string[] = [];
        for await (const msg of client.fetch(
          selected,
          { uid: true, envelope: true, flags: true },
          { uid: true },
        )) {
          const seen = msg.flags?.has("\\Seen") ?? false;
          rows.push(summarizeEnvelope(msg.uid, msg.envelope ?? {}, seen));
        }
        rows.reverse();
        return text(
          `Found ${uids.length} match(es) in "${mailbox}", showing ${rows.length}:\n\n` +
            rows.join("\n"),
        );
      } finally {
        lock.release();
      }
    });
  },
);

server.registerTool(
  "mark_read",
  {
    title: "Mark message read/unread",
    description: "Add or remove the \\Seen flag on a message by UID.",
    inputSchema: {
      mailbox: z.string().default("INBOX").describe("Mailbox the message is in."),
      uid: z.number().int().positive().describe("The message UID."),
      seen: z
        .boolean()
        .default(true)
        .describe("true to mark read, false to mark unread."),
    },
  },
  async ({ mailbox, uid, seen }) => {
    return withImap(async (client) => {
      const lock = await client.getMailboxLock(mailbox);
      try {
        const ok = seen
          ? await client.messageFlagsAdd(String(uid), ["\\Seen"], { uid: true })
          : await client.messageFlagsRemove(String(uid), ["\\Seen"], {
              uid: true,
            });
        return ok
          ? text(`Marked UID ${uid} as ${seen ? "read" : "unread"}.`)
          : errorText(`Could not update UID ${uid} in "${mailbox}".`);
      } finally {
        lock.release();
      }
    });
  },
);

server.registerTool(
  "send_email",
  {
    title: "Send email",
    description:
      "Send an email through Proton Bridge's SMTP server. Provide at least one " +
      "recipient and either a text or html body.",
    inputSchema: {
      to: z
        .array(z.string())
        .min(1)
        .describe("Recipient email addresses."),
      cc: z.array(z.string()).optional().describe("Cc email addresses."),
      bcc: z.array(z.string()).optional().describe("Bcc email addresses."),
      subject: z.string().describe("Email subject line."),
      text: z.string().optional().describe("Plain-text body."),
      html: z.string().optional().describe("HTML body (optional)."),
      from: z
        .string()
        .optional()
        .describe(
          "Send from this address. Must be one of your Proton account's own " +
            "addresses/aliases (use list_addresses to see them). Defaults to " +
            "the primary account address.",
        ),
      reply_to: z
        .string()
        .optional()
        .describe("Reply-To address, if different from the sender."),
    },
  },
  async ({ to, cc, bcc, subject, text: textBody, html, from, reply_to }) => {
    if (!textBody && !html) {
      return errorText("Provide a text or html body.");
    }
    const cfg = loadConfig();
    const transport = nodemailer.createTransport({
      host: cfg.host,
      port: cfg.smtpPort,
      secure: false, // Bridge SMTP uses STARTTLS on the SMTP port.
      requireTLS: true,
      auth: { user: cfg.username, pass: cfg.password },
      tls: { rejectUnauthorized: cfg.rejectUnauthorized },
    });
    try {
      const info = await transport.sendMail({
        from: from || cfg.from,
        to,
        cc,
        bcc,
        subject,
        text: textBody,
        html,
        replyTo: reply_to,
      });
      return text(
        `Sent from ${from || cfg.from}. messageId: ${info.messageId}\nAccepted: ${
          (info.accepted as string[]).join(", ") || "(none)"
        }${
          (info.rejected as string[]).length
            ? `\nRejected: ${(info.rejected as string[]).join(", ")}`
            : ""
        }`,
      );
    } finally {
      transport.close();
    }
  },
);

server.registerTool(
  "list_addresses",
  {
    title: "List your sendable addresses",
    description:
      "List the email addresses (aliases) on this Proton account that you can " +
      "send from. Bridge exposes no address list directly, so this is derived " +
      "from any addresses you've sent as (scanned from the Sent folder) plus " +
      "any configured via PROTON_BRIDGE_ADDRESSES. Pass any of these as the " +
      "'from' argument of send_email.",
    inputSchema: {
      scan_limit: z
        .number()
        .int()
        .min(0)
        .max(2000)
        .default(500)
        .describe(
          "How many recent Sent messages to scan for sender addresses (0 to " +
            "skip scanning and only use the configured/primary addresses).",
        ),
    },
  },
  async ({ scan_limit }) => {
    const cfg = loadConfig();
    // Case-insensitive set, but remember the first-seen original casing.
    const seen = new Map<string, string>();
    const add = (addr?: string) => {
      const a = addr?.trim();
      if (a && !seen.has(a.toLowerCase())) seen.set(a.toLowerCase(), a);
    };
    add(cfg.from); // primary / default sender
    for (const a of cfg.addresses) add(a); // operator-configured aliases

    let scannedNote = "";
    if (scan_limit > 0) {
      await withImap(async (client) => {
        const boxes = await client.list();
        const sent =
          boxes.find((b) => b.specialUse === "\\Sent")?.path ?? "Sent";
        try {
          const lock = await client.getMailboxLock(sent);
          try {
            const exists = (client.mailbox as MailboxObject).exists;
            if (exists) {
              const start = Math.max(1, exists - scan_limit + 1);
              for await (const msg of client.fetch(`${start}:*`, {
                uid: true,
                envelope: true,
              })) {
                for (const f of msg.envelope?.from ?? []) add(f.address);
              }
            }
            scannedNote = `Scanned up to ${scan_limit} messages in "${sent}".`;
          } finally {
            lock.release();
          }
        } catch {
          scannedNote = `(Could not open a Sent folder to scan.)`;
        }
      });
    }

    const addresses = [...seen.values()];
    const lines = addresses.map((a) =>
      a.toLowerCase() === cfg.from.toLowerCase() ? `${a}  (default)` : a,
    );
    return text(
      `Sendable addresses (${addresses.length}):\n` +
        lines.join("\n") +
        (scannedNote ? `\n\n${scannedNote}` : "") +
        `\n\nUse any of these as the 'from' argument of send_email. ` +
        `If one is missing, add it to PROTON_BRIDGE_ADDRESSES.`,
    );
  },
);

/* --------------------------------------------------------------------- main */

async function main() {
  // Fail fast with a clear message if credentials are missing.
  loadConfig();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Note: never write to stdout — it is the MCP transport. Logs go to stderr.
  process.stderr.write("proton-mcp server running on stdio\n");
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err instanceof Error ? err.message : err}\n`);
  process.exit(1);
});
