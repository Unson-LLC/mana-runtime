# DocuSign contract-ledger synchronization

Mana treats DocuSign as the source of truth for envelope state and the Google
Sheet contract ledger as a searchable operational view. `envelopeId` is the
immutable synchronization key. Do not infer identity from the subject line.

## MCP boundary

- MCP server: `docusign`
- Expected user: `info@unson.jp`
- API: DocuSign eSignature REST API v2.1
- Authentication: OAuth JWT Grant for the unattended runtime
- Tools: `auth_status`, `list_envelopes`, `list_contract_ledger_rows`,
  `get_envelope`, `list_recipients`, and `list_documents`

The DocuSign MCP is read-only. Spreadsheet mutation remains in the separately
authorized `google-drive` MCP. A placement needs both MCP servers to synchronize
the ledger; configuring them globally does not grant them to a placement.

## Secret keys

Store values in Infisical, never in Git or Slack:

- `DOCUSIGN_ACCOUNT_ID`
- `DOCUSIGN_INTEGRATION_KEY`
- `DOCUSIGN_USER_ID`
- `DOCUSIGN_PRIVATE_KEY_BASE64` (or project a mode-`0600` key file and set
  `DOCUSIGN_PRIVATE_KEY_PATH`)

Non-secret settings are `DOCUSIGN_AUTH_SERVER=account.docusign.com` and
`DOCUSIGN_EXPECTED_USER_EMAIL=info@unson.jp`. A DocuSign administrator must
grant the integration key the `signature` and `impersonation` OAuth scopes.
Use `account-d.docusign.com` only for the developer environment.

## Runtime configuration

```yaml
mcp:
  custom:
    docusign:
      enabled: true
      command: /home/ryoko/.nvm/versions/node/v22.23.1/bin/node
      args: [/home/ryoko/mcp/docusign-server.js]
      env:
        DOCUSIGN_AUTH_SERVER: account.docusign.com
        DOCUSIGN_EXPECTED_USER_EMAIL: info@unson.jp
        DOCUSIGN_ACCOUNT_ID: ${DOCUSIGN_ACCOUNT_ID}
        DOCUSIGN_INTEGRATION_KEY: ${DOCUSIGN_INTEGRATION_KEY}
        DOCUSIGN_USER_ID: ${DOCUSIGN_USER_ID}
        DOCUSIGN_PRIVATE_KEY_BASE64: ${DOCUSIGN_PRIVATE_KEY_BASE64}
```

Copy the built adapter without credential files:

```bash
install -m 0755 \
  /home/ryoko/current/packages/jimmy/dist/src/mcp/docusign-server.js \
  /home/ryoko/mcp/docusign-server.js
```

## Initial synchronization

1. Call `auth_status` and verify both expected email and account ID.
2. Page through `list_contract_ledger_rows`; never treat a failed or partial page as an
   empty account.
3. Upsert Sheet rows by `envelopeId`, stored in the existing `管理番号` column,
   using `write_sheet_values`. The adapter maps subject, recipients, status,
   completion date, DocuSign URL, service name, and sender note. It leaves fields
   that DocuSign cannot determine (contract type, term, renewal, amount, and
   payment terms) empty so that it never invents contract facts.
4. Read the written range back with `get_sheet_values`.

Recommended columns are envelope ID, subject, status, sender, recipients,
sent date, completed date, voided date, last-modified date, and DocuSign link.

## Continuous synchronization

The MCP enables initial import and reconciliation. Real-time updates should use
a separately authenticated DocuSign Connect webhook. Until that endpoint is
deployed and its signature is verified, schedule polling and report webhook
coverage as unverified rather than complete.
