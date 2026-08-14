export interface AnthropicCredentialEnv {
  ANTHROPIC_API_KEY?: string;
  CLAUDE_CODE_OAUTH_TOKEN?: string;
}

export function hasAnthropicCredential(env: AnthropicCredentialEnv): boolean {
  return Boolean(env.ANTHROPIC_API_KEY || env.CLAUDE_CODE_OAUTH_TOKEN);
}

export function applyAnthropicCredential(
  source: Headers,
  env: AnthropicCredentialEnv,
): Headers | null {
  const headers = new Headers(source);
  headers.delete("Authorization");
  headers.delete("x-api-key");

  if (env.ANTHROPIC_API_KEY) {
    headers.set("x-api-key", env.ANTHROPIC_API_KEY);
    return headers;
  }
  if (env.CLAUDE_CODE_OAUTH_TOKEN) {
    headers.set("Authorization", `Bearer ${env.CLAUDE_CODE_OAUTH_TOKEN}`);
    return headers;
  }
  return null;
}
