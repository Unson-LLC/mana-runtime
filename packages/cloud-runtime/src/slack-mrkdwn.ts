/**
 * Render untrusted angle-bracket sequences literally in Slack mrkdwn.
 *
 * Slack assigns active meaning to raw `<...>` sequences (mentions, broadcasts,
 * links, and special commands). Replacing only the raw delimiters keeps normal
 * mrkdwn and bare URLs intact, and is idempotent for already escaped text.
 */
export function escapeUntrustedSlackMrkdwn(text: string): string {
  return text.replace(/<([^<>\r\n]*)>/g, "&lt;$1&gt;");
}
