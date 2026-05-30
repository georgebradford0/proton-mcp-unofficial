/**
 * Configuration for connecting to Proton Mail Bridge.
 *
 * Proton Bridge runs a local IMAP and SMTP server on your machine and proxies
 * to Proton Mail over an encrypted connection. By default it listens on
 * 127.0.0.1 with IMAP on port 1143 and SMTP on port 1025, using STARTTLS with a
 * self-signed certificate. The username is your Proton address and the password
 * is the *Bridge-specific* password shown in the Bridge app (not your normal
 * Proton login password).
 */

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback;
  return !/^(0|false|no|off)$/i.test(value.trim());
}

function int(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(
      `Missing required environment variable ${name}. ` +
        `Set it to the value shown in the Proton Bridge app.`,
    );
  }
  return value.trim();
}

export interface ProtonConfig {
  host: string;
  imapPort: number;
  smtpPort: number;
  username: string;
  password: string;
  /**
   * Default From address used by send_email when no `from` is given.
   * Sourced from PROTON_DEFAULT_ADDRESS (preferred), then the legacy
   * PROTON_BRIDGE_FROM, then the account username.
   */
  from: string;
  /**
   * The account's addresses/aliases you can send from. From
   * PROTON_BRIDGE_ADDRESSES (comma-separated). This is the authoritative list
   * returned by the list_addresses tool.
   */
  addresses: string[];
  /**
   * Whether to verify the TLS certificate. Proton Bridge uses a self-signed
   * certificate, so this defaults to false. Set
   * PROTON_BRIDGE_TLS_REJECT_UNAUTHORIZED=true once you have installed the
   * Bridge CA certificate into your trust store.
   */
  rejectUnauthorized: boolean;
}

let cached: ProtonConfig | undefined;

export function loadConfig(): ProtonConfig {
  if (cached) return cached;
  const username = required("PROTON_BRIDGE_USERNAME");
  cached = {
    host: process.env.PROTON_BRIDGE_HOST?.trim() || "127.0.0.1",
    imapPort: int(process.env.PROTON_BRIDGE_IMAP_PORT, 1143),
    smtpPort: int(process.env.PROTON_BRIDGE_SMTP_PORT, 1025),
    username,
    password: required("PROTON_BRIDGE_PASSWORD"),
    from:
      process.env.PROTON_DEFAULT_ADDRESS?.trim() ||
      process.env.PROTON_BRIDGE_FROM?.trim() ||
      username,
    addresses: (process.env.PROTON_BRIDGE_ADDRESSES || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    rejectUnauthorized: bool(
      process.env.PROTON_BRIDGE_TLS_REJECT_UNAUTHORIZED,
      false,
    ),
  };
  return cached;
}
