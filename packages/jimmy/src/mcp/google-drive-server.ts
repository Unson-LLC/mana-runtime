#!/usr/bin/env node
/**
 * Account-pinned Google Drive MCP adapter.
 *
 * Google Workspace CLI removed its native MCP transport after v0.6.3. This
 * adapter keeps the current CLI as the Google API client and exposes a small,
 * auditable Drive and Sheets MCP surface to Mana Runtime.
 */

import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const GWS_BIN = process.env.GOOGLE_DRIVE_CLI_BIN || "gws";
const EXPECTED_ACCOUNT = process.env.GOOGLE_DRIVE_EXPECTED_ACCOUNT || "";
const ALLOWED_UPLOAD_ROOTS = (process.env.GOOGLE_DRIVE_ALLOWED_UPLOAD_ROOTS || "")
  .split(",")
  .map((entry) => entry.trim())
  .filter(Boolean);

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
}

const FILE_FIELDS = "id,name,mimeType,webViewLink,webContentLink,parents,createdTime,modifiedTime,owners(emailAddress,displayName)";

export const GOOGLE_DRIVE_TOOLS = [
  {
    name: "auth_status",
    description: "Verify that the Drive credential belongs to the configured Google account.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "list_files",
    description: "List or search files visible to the configured Google Drive account.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Google Drive files.list q expression (optional)" },
        pageSize: { type: "number", minimum: 1, maximum: 100, default: 20 },
        orderBy: { type: "string", default: "modifiedTime desc" },
        pageToken: { type: "string" },
      },
    },
  },
  {
    name: "get_file",
    description: "Get Drive metadata and web links for one file.",
    inputSchema: {
      type: "object" as const,
      properties: { fileId: { type: "string" } },
      required: ["fileId"],
    },
  },
  {
    name: "create_folder",
    description: "Create a folder in Drive and return its ID and web link.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: { type: "string" },
        parentId: { type: "string", description: "Parent folder ID; omit for My Drive root" },
      },
      required: ["name"],
    },
  },
  {
    name: "upload_file",
    description: "Upload a generated local artifact from an explicitly allowed runtime directory and return its Drive web link.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sourcePath: { type: "string", description: "Absolute path below GOOGLE_DRIVE_ALLOWED_UPLOAD_ROOTS" },
        name: { type: "string", description: "Drive filename; defaults to the local basename" },
        parentId: { type: "string", description: "Destination folder ID; omit for My Drive root" },
        mimeType: { type: "string", description: "Optional upload content type" },
      },
      required: ["sourcePath"],
    },
  },
  {
    name: "create_spreadsheet",
    description: "Create an empty Google Sheets spreadsheet in Drive and return its ID and web link.",
    inputSchema: {
      type: "object" as const,
      properties: {
        title: { type: "string", description: "Spreadsheet title" },
        parentId: { type: "string", description: "Destination folder ID; omit for My Drive root" },
      },
      required: ["title"],
    },
  },
  {
    name: "write_sheet_values",
    description: "Write a two-dimensional array of values to a Google Sheets range.",
    inputSchema: {
      type: "object" as const,
      properties: {
        spreadsheetId: { type: "string" },
        range: { type: "string", description: "A1 notation, for example Sheet1!A1:P2" },
        values: {
          type: "array",
          description: "Rows of string, number, boolean, or null cell values",
          items: {
            type: "array",
            items: { type: ["string", "number", "boolean", "null"] },
          },
        },
        valueInputOption: {
          type: "string",
          enum: ["RAW", "USER_ENTERED"],
          default: "USER_ENTERED",
        },
      },
      required: ["spreadsheetId", "range", "values"],
    },
  },
  {
    name: "get_sheet_values",
    description: "Read values from a Google Sheets range for verification or follow-up editing.",
    inputSchema: {
      type: "object" as const,
      properties: {
        spreadsheetId: { type: "string" },
        range: { type: "string", description: "A1 notation" },
      },
      required: ["spreadsheetId", "range"],
    },
  },
] as const;

async function runGws(args: string[], cwd?: string): Promise<unknown> {
  const { stdout } = await execFileAsync(GWS_BIN, args, {
    cwd,
    env: process.env,
    timeout: 120_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  const text = stdout.trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Google Workspace CLI returned non-JSON output: ${text.slice(0, 300)}`);
  }
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function requireNonEmptyString(value: unknown, field: string): string {
  const result = typeof value === "string" ? value.trim() : "";
  if (!result) throw new Error(`${field} must be a non-empty string`);
  return result;
}

export type SheetCellValue = string | number | boolean | null;

export function normalizeSheetValues(value: unknown): SheetCellValue[][] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("values must be a non-empty two-dimensional array");
  }
  return value.map((row, rowIndex) => {
    if (!Array.isArray(row)) throw new Error(`values[${rowIndex}] must be an array`);
    return row.map((cell, columnIndex) => {
      if (cell === null || ["string", "number", "boolean"].includes(typeof cell)) {
        return cell as SheetCellValue;
      }
      throw new Error(`values[${rowIndex}][${columnIndex}] has an unsupported type`);
    });
  });
}

async function verifyAccount(): Promise<Record<string, unknown>> {
  const result = asObject(await runGws([
    "drive", "about", "get", "--params", JSON.stringify({ fields: "user(emailAddress,displayName)" }),
  ]));
  const user = asObject(result.user);
  const email = String(user.emailAddress || "");
  if (!email) throw new Error("Drive did not return the authenticated account email");
  if (EXPECTED_ACCOUNT && email.toLowerCase() !== EXPECTED_ACCOUNT.toLowerCase()) {
    throw new Error(`Drive account mismatch: expected ${EXPECTED_ACCOUNT}, got ${email}`);
  }
  return { authenticated: true, expectedAccount: EXPECTED_ACCOUNT || null, user };
}

async function assertAllowedUploadPath(sourcePath: string): Promise<string> {
  if (!path.isAbsolute(sourcePath)) throw new Error("sourcePath must be absolute");
  if (ALLOWED_UPLOAD_ROOTS.length === 0) throw new Error("File uploads are disabled: GOOGLE_DRIVE_ALLOWED_UPLOAD_ROOTS is empty");
  const source = await realpath(sourcePath);
  const roots = await Promise.all(ALLOWED_UPLOAD_ROOTS.map((root) => realpath(root)));
  if (!roots.some((root) => source === root || source.startsWith(`${root}${path.sep}`))) {
    throw new Error("sourcePath is outside GOOGLE_DRIVE_ALLOWED_UPLOAD_ROOTS");
  }
  return source;
}

export async function handleGoogleDriveTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const account = await verifyAccount();

  switch (name) {
    case "auth_status":
      return account;
    case "list_files": {
      const pageSize = Math.max(1, Math.min(100, Number(args.pageSize || 20)));
      const params: Record<string, unknown> = {
        pageSize,
        orderBy: String(args.orderBy || "modifiedTime desc"),
        spaces: "drive",
        fields: `nextPageToken,files(${FILE_FIELDS})`,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      };
      if (args.query) params.q = String(args.query);
      if (args.pageToken) params.pageToken = String(args.pageToken);
      return runGws(["drive", "files", "list", "--params", JSON.stringify(params)]);
    }
    case "get_file":
      return runGws(["drive", "files", "get", "--params", JSON.stringify({
        fileId: requireNonEmptyString(args.fileId, "fileId"), fields: FILE_FIELDS, supportsAllDrives: true,
      })]);
    case "create_folder": {
      const metadata: Record<string, unknown> = {
        name: requireNonEmptyString(args.name, "name"),
        mimeType: "application/vnd.google-apps.folder",
      };
      if (args.parentId) metadata.parents = [String(args.parentId)];
      return runGws(["drive", "files", "create", "--params", JSON.stringify({
        fields: FILE_FIELDS, supportsAllDrives: true,
      }), "--json", JSON.stringify(metadata)]);
    }
    case "upload_file": {
      const source = await assertAllowedUploadPath(String(args.sourcePath || ""));
      const metadata: Record<string, unknown> = { name: String(args.name || path.basename(source)) };
      if (args.parentId) metadata.parents = [String(args.parentId)];
      const cliArgs = [
        "drive", "files", "create",
        "--params", JSON.stringify({ fields: FILE_FIELDS, supportsAllDrives: true }),
        "--json", JSON.stringify(metadata),
        "--upload", path.basename(source),
      ];
      if (args.mimeType) cliArgs.push("--upload-content-type", String(args.mimeType));
      return runGws(cliArgs, path.dirname(source));
    }
    case "create_spreadsheet": {
      const metadata: Record<string, unknown> = {
        name: requireNonEmptyString(args.title, "title"),
        mimeType: "application/vnd.google-apps.spreadsheet",
      };
      if (args.parentId) metadata.parents = [requireNonEmptyString(args.parentId, "parentId")];
      return runGws(["drive", "files", "create", "--params", JSON.stringify({
        fields: FILE_FIELDS, supportsAllDrives: true,
      }), "--json", JSON.stringify(metadata)]);
    }
    case "write_sheet_values": {
      const spreadsheetId = requireNonEmptyString(args.spreadsheetId, "spreadsheetId");
      const range = requireNonEmptyString(args.range, "range");
      const valueInputOption = args.valueInputOption === "RAW" ? "RAW" : "USER_ENTERED";
      const values = normalizeSheetValues(args.values);
      return runGws(["sheets", "spreadsheets", "values", "update", "--params", JSON.stringify({
        spreadsheetId, range, valueInputOption,
      }), "--json", JSON.stringify({ majorDimension: "ROWS", values })]);
    }
    case "get_sheet_values":
      return runGws(["sheets", "spreadsheets", "values", "get", "--params", JSON.stringify({
        spreadsheetId: requireNonEmptyString(args.spreadsheetId, "spreadsheetId"),
        range: requireNonEmptyString(args.range, "range"),
      })]);
    default:
      throw new Error(`Unknown Google Drive tool: ${name}`);
  }
}

function sendResponse(response: JsonRpcResponse): void {
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

async function handleRequest(request: JsonRpcRequest): Promise<void> {
  const { id, method, params } = request;
  if (method === "notifications/initialized") return;
  if (method === "initialize") {
    sendResponse({ jsonrpc: "2.0", id, result: {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "mana-google-drive", version: "1.1.0" },
    } });
    return;
  }
  if (method === "tools/list") {
    sendResponse({ jsonrpc: "2.0", id, result: { tools: GOOGLE_DRIVE_TOOLS } });
    return;
  }
  if (method === "tools/call") {
    try {
      const result = await handleGoogleDriveTool(
        String(params?.name || ""),
        asObject(params?.arguments),
      );
      sendResponse({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(result) }] } });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendResponse({ jsonrpc: "2.0", id, result: {
        content: [{ type: "text", text: `Error: ${message}` }], isError: true,
      } });
    }
    return;
  }
  sendResponse({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
}

export function startGoogleDriveMcpServer(): void {
  const rl = createInterface({ input: process.stdin });
  const pendingRequests = new Set<Promise<void>>();
  rl.on("line", (line) => {
    try {
      const request = JSON.parse(line) as JsonRpcRequest;
      const pending = handleRequest(request);
      pendingRequests.add(pending);
      void pending.finally(() => pendingRequests.delete(pending));
    } catch {
      // Ignore unparseable stdio noise.
    }
  });
  rl.on("close", () => {
    void Promise.allSettled([...pendingRequests]).then(() => process.exit(0));
  });
}

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  startGoogleDriveMcpServer();
}
