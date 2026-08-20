import { TenantBoundaryError } from "./errors.js";
import { assertCanonicalSharedId } from "./ids.js";

export type SlackInstallationBinding = {
  installation_intent_id: string;
  tenant_id: string;
  app_id: string;
  expected_workspace_id?: string;
  expected_enterprise_id?: string;
  initiated_by_person_id: string;
  expected_connection_revision?: string;
};

export type SlackInstallationIntent = SlackInstallationBinding & {
  state_hash: string;
  nonce_hash: string;
  issued_at: string;
  expires_at: string;
  consumed_at: string | null;
};

export interface SlackInstallationIntentTransaction {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
}

export interface SlackInstallationIntentStorage extends SlackInstallationIntentTransaction {
  transaction<T>(callback: (transaction: SlackInstallationIntentTransaction) => Promise<T>): Promise<T>;
}

export interface SlackInstallationIntentPort {
  create(intent: SlackInstallationIntent): Promise<void>;
  claim(input: { state_hash: string; nonce_hash: string; now: string }): Promise<SlackInstallationIntent>;
}

function intentKey(stateHash: string): string {
  if (!/^sha256:[a-f0-9]{64}$/.test(stateHash)) {
    throw new TenantBoundaryError("slack_oauth", "INSTALLATION_STATE_INVALID");
  }
  return `slack-installation-intent:${stateHash}`;
}

function validateBinding(binding: SlackInstallationBinding): SlackInstallationBinding {
  assertCanonicalSharedId(binding.installation_intent_id, "insi_", "slack_oauth");
  assertCanonicalSharedId(binding.tenant_id, "ten_", "slack_oauth");
  assertCanonicalSharedId(binding.initiated_by_person_id, "per_", "slack_oauth");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(binding.app_id)
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(binding.initiated_by_person_id)
    || (binding.expected_workspace_id !== undefined
      && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(binding.expected_workspace_id))
    || (binding.expected_enterprise_id !== undefined
      && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(binding.expected_enterprise_id))
    || (binding.expected_connection_revision !== undefined
      && !/^(0|[1-9][0-9]*)$/.test(binding.expected_connection_revision))) {
    throw new TenantBoundaryError("slack_oauth", "INSTALLATION_BINDING_MISMATCH");
  }
  return structuredClone(binding);
}

export class SlackInstallationIntentStore implements SlackInstallationIntentPort {
  constructor(private readonly storage: SlackInstallationIntentStorage) {}

  async create(intent: SlackInstallationIntent): Promise<void> {
    const binding = validateBinding(intent);
    if (!/^sha256:[a-f0-9]{64}$/.test(intent.nonce_hash)
      || !Number.isFinite(Date.parse(intent.issued_at))
      || !Number.isFinite(Date.parse(intent.expires_at))
      || Date.parse(intent.expires_at) <= Date.parse(intent.issued_at)
      || Date.parse(intent.expires_at) - Date.parse(intent.issued_at) > 600_000
      || intent.consumed_at !== null) {
      throw new TenantBoundaryError("slack_oauth", "INSTALLATION_STATE_INVALID");
    }
    const stored: SlackInstallationIntent = {
      ...binding,
      state_hash: intent.state_hash,
      nonce_hash: intent.nonce_hash,
      issued_at: intent.issued_at,
      expires_at: intent.expires_at,
      consumed_at: null,
    };
    await this.storage.transaction(async (transaction) => {
      const key = intentKey(intent.state_hash);
      if (await transaction.get(key)) {
        throw new TenantBoundaryError("slack_oauth", "INSTALLATION_STATE_INVALID");
      }
      await transaction.put(key, stored);
    });
  }

  async claim(input: { state_hash: string; nonce_hash: string; now: string }): Promise<SlackInstallationIntent> {
    return this.storage.transaction(async (transaction) => {
      const key = intentKey(input.state_hash);
      const current = await transaction.get<SlackInstallationIntent>(key);
      if (!current || current.state_hash !== input.state_hash || current.nonce_hash !== input.nonce_hash) {
        throw new TenantBoundaryError("slack_oauth", "INSTALLATION_STATE_INVALID");
      }
      if (current.consumed_at !== null) {
        throw new TenantBoundaryError("slack_oauth", "INSTALLATION_STATE_REPLAYED");
      }
      if (!Number.isFinite(Date.parse(input.now)) || Date.parse(current.expires_at) <= Date.parse(input.now)) {
        throw new TenantBoundaryError("slack_oauth", "INSTALLATION_STATE_EXPIRED");
      }
      const consumed = { ...current, consumed_at: input.now };
      await transaction.put(key, consumed);
      return structuredClone(consumed);
    });
  }
}
