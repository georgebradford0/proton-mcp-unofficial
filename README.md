# proton-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server that lets an
LLM **read and send email through [Proton Mail Bridge](https://proton.me/mail/bridge)**.

Proton Mail is end-to-end encrypted and has no plain IMAP/SMTP API. Proton
Bridge is Proton's official desktop app that runs a **local** IMAP and SMTP
server on your machine and transparently encrypts/decrypts traffic to Proton.
This MCP server talks to that local Bridge:

- **Reading & searching** → Bridge's local **IMAP** server
- **Sending** → Bridge's local **SMTP** server

## Tools

| Tool | Description |
| --- | --- |
| `list_mailboxes` | List all folders with total/unread counts. |
| `list_messages` | List recent messages in a mailbox (newest first). |
| `read_message` | Fetch a full message (headers + body) by UID. |
| `search_messages` | Search by from/to/subject/body/date/unread. |
| `mark_read` | Add or remove the `\Seen` flag on a message. |
| `send_email` | Send an email (to/cc/bcc, subject, text/html). |

## Prerequisites

1. A Proton Mail account (Bridge requires a paid plan).
2. [Proton Mail Bridge](https://proton.me/mail/bridge) installed, running, and
   signed in.
3. Node.js 18+.

### Get your Bridge connection details

Open the Bridge app → select your account → **Mailbox details**. You'll see:

- **Username** — your Proton address (e.g. `you@proton.me`)
- **Password** — a *Bridge-specific* password (NOT your Proton login password)
- **IMAP** host/port — usually `127.0.0.1:1143` (STARTTLS)
- **SMTP** host/port — usually `127.0.0.1:1025` (STARTTLS)

Bridge uses a **self-signed TLS certificate**, so certificate verification is
disabled by default in this server. To enable it, install the Bridge CA
certificate (Bridge → Settings → "Install" / export the cert into your trust
store) and set `PROTON_BRIDGE_TLS_REJECT_UNAUTHORIZED=true`.

## Install & build

```bash
npm install
npm run build
```

### Debian / Ubuntu one-shot setup (incl. headless)

On a Debian-based system you can install everything — system packages, the
`pass` keychain backend Bridge needs when there's no GUI, Node.js, Proton
Bridge, and this MCP's build — with the included script:

```bash
./install-debian.sh
```

It's idempotent (safe to re-run) and prints the remaining one-time steps
(`protonmail-bridge --cli` to log in, then run Bridge in the background). If the
default Bridge version 404s, override it:

```bash
BRIDGE_DEB_URL="https://proton.me/download/bridge/protonmail-bridge_X.Y.Z-1_amd64.deb" ./install-debian.sh
```

## Configuration

All configuration is via environment variables (see [`.env.example`](.env.example)):

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `PROTON_BRIDGE_USERNAME` | ✅ | — | Your Proton address. |
| `PROTON_BRIDGE_PASSWORD` | ✅ | — | Bridge-specific password. |
| `PROTON_BRIDGE_HOST` | | `127.0.0.1` | |
| `PROTON_BRIDGE_IMAP_PORT` | | `1143` | |
| `PROTON_BRIDGE_SMTP_PORT` | | `1025` | |
| `PROTON_BRIDGE_FROM` | | = username | From header for sent mail. |
| `PROTON_BRIDGE_TLS_REJECT_UNAUTHORIZED` | | `false` | Set `true` after installing the Bridge CA. |

## Connect it to an MCP client

### Claude Desktop / Claude Code

Add to your MCP config (`claude_desktop_config.json`, or via
`claude mcp add` for Claude Code):

```json
{
  "mcpServers": {
    "proton": {
      "command": "node",
      "args": ["/absolute/path/to/proton-mcp/dist/index.js"],
      "env": {
        "PROTON_BRIDGE_USERNAME": "you@proton.me",
        "PROTON_BRIDGE_PASSWORD": "your-bridge-password"
      }
    }
  }
}
```

For Claude Code specifically:

```bash
claude mcp add proton \
  -e PROTON_BRIDGE_USERNAME=you@proton.me \
  -e PROTON_BRIDGE_PASSWORD=your-bridge-password \
  -- node /absolute/path/to/proton-mcp/dist/index.js
```

## Quick local test

With Bridge running and the env vars set, you can smoke-test the server with the
MCP Inspector:

```bash
PROTON_BRIDGE_USERNAME=you@proton.me \
PROTON_BRIDGE_PASSWORD=your-bridge-password \
npx @modelcontextprotocol/inspector node dist/index.js
```

Then call `list_mailboxes`, `list_messages`, etc. from the Inspector UI.

## Security notes

- Credentials are read from environment variables only; nothing is written to
  disk. Keep your `.env` out of version control (it is `.gitignore`d).
- The server communicates only with your **local** Bridge — no third party sees
  your password or mail.
- `send_email` sends real email. Review what the LLM drafts before letting it
  send autonomously.

## License

MIT
