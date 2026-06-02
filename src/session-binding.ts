import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { resolveOpenClawHomeDir, resolveOpenClawStateDir } from "./paths.js";

type UnknownRecord = Record<string, unknown>;

type SessionStoreEntry = {
  sessionId?: unknown;
  updatedAt?: unknown;
  sessionFile?: unknown;
  subject?: unknown;
  label?: unknown;
  displayName?: unknown;
  lastChannel?: unknown;
  lastTo?: unknown;
  lastAccountId?: unknown;
  lastThreadId?: unknown;
  deliveryContext?: unknown;
  origin?: unknown;
};

type StoredBindingsFile = {
  version: 1;
  bindings: Record<string, Chat4000SessionBinding>;
};

export type OpenClawSessionCandidate = {
  sessionKey: string;
  agentId: string;
  sessionId: string;
  storePath: string;
  sessionFile?: string | undefined;
  updatedAt: number;
  label: string;
  lastPreview?: string | undefined;
  lastChannel?: string | undefined;
  lastTo?: string | undefined;
  lastAccountId?: string | undefined;
};

export type Chat4000SessionBinding = {
  accountId: string;
  groupId: string;
  targetSessionKey: string;
  agentId: string;
  storePath: string;
  sessionId: string;
  label: string;
  lastPreview?: string | undefined;
  lastChannel?: string | undefined;
  updatedAt: number;
  boundAt: string;
};

function resolveBindingsFilePath(): string {
  return path.join(resolveOpenClawStateDir(), "plugins", "chat4000", "session-bindings.json");
}

function normalizeNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function expandHomePath(value: string): string {
  if (!value.startsWith("~")) {
    return path.resolve(value);
  }
  return path.resolve(path.join(process.env.HOME ?? resolveOpenClawHomeDir(), value.slice(1)));
}

function resolveConfiguredSessionStorePath(
  cfg: Record<string, unknown> | undefined,
  agentId: string,
): string | undefined {
  const sessionCfg = cfg?.session;
  if (!sessionCfg || typeof sessionCfg !== "object") {
    return undefined;
  }
  const rawStore = normalizeNonEmptyString((sessionCfg as { store?: unknown }).store);
  if (!rawStore) {
    return undefined;
  }
  const withAgent = rawStore.includes("{agentId}")
    ? rawStore.replaceAll("{agentId}", agentId)
    : rawStore;
  return expandHomePath(withAgent);
}

function listKnownAgentIds(): string[] {
  const agentsDir = path.join(resolveOpenClawStateDir(), "agents");
  if (!existsSync(agentsDir)) {
    return ["main"];
  }
  const names = readdirSync(agentsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name.trim())
    .filter(Boolean);
  return names.length > 0 ? names : ["main"];
}

function resolveSessionStorePaths(cfg?: Record<string, unknown>): string[] {
  const paths = new Set<string>();
  for (const agentId of listKnownAgentIds()) {
    paths.add(path.join(resolveOpenClawStateDir(), "agents", agentId, "sessions", "sessions.json"));
    const configured = resolveConfiguredSessionStorePath(cfg, agentId);
    if (configured) {
      paths.add(configured);
    }
  }
  return [...paths];
}

function parseAgentIdFromSessionKey(sessionKey: string): string | undefined {
  if (!sessionKey.startsWith("agent:")) {
    return undefined;
  }
  const parts = sessionKey.split(":");
  return normalizeNonEmptyString(parts[1]);
}

function isUserFacingSessionKey(sessionKey: string): boolean {
  if (!sessionKey.startsWith("agent:")) {
    return false;
  }
  return (
    !sessionKey.includes(":cron:") &&
    !sessionKey.includes(":acp:") &&
    !sessionKey.includes(":subagent:")
  );
}

function extractTextFromTranscriptContent(content: unknown): string | null {
  if (typeof content === "string") {
    const normalized = content.replace(/\s+/g, " ").trim();
    return normalized || null;
  }
  if (!Array.isArray(content)) {
    return null;
  }
  const parts = content
    .map((item) => {
      if (!item || typeof item !== "object") {
        return "";
      }
      const text = (item as { text?: unknown }).text;
      return typeof text === "string" ? text : "";
    })
    .filter(Boolean);
  if (parts.length === 0) {
    return null;
  }
  return parts.join(" ").replace(/\s+/g, " ").trim() || null;
}

function readLastTranscriptPreview(candidatePaths: string[]): string | undefined {
  for (const candidate of candidatePaths) {
    if (!existsSync(candidate)) {
      continue;
    }
    try {
      const lines = readFileSync(candidate, "utf8")
        .split(/\r?\n/)
        .filter((line) => line.trim().length > 0);
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const parsed = JSON.parse(lines[index] ?? "") as { message?: { content?: unknown } };
        const text = extractTextFromTranscriptContent(parsed.message?.content);
        if (text) {
          return text.length > 120 ? `${text.slice(0, 117)}...` : text;
        }
      }
    } catch {
      // Ignore malformed transcript files and try the next candidate.
    }
  }
  return undefined;
}

function resolveTranscriptCandidates(
  storePath: string,
  sessionId: string,
  entry: SessionStoreEntry,
): string[] {
  const sessionsDir = path.dirname(storePath);
  const candidates = new Set<string>();
  const sessionFile = normalizeNonEmptyString(entry.sessionFile);
  if (sessionFile) {
    candidates.add(
      path.isAbsolute(sessionFile) ? sessionFile : path.join(sessionsDir, sessionFile),
    );
  }
  candidates.add(path.join(sessionsDir, `${sessionId}.jsonl`));
  const threadId = normalizeNonEmptyString(entry.lastThreadId);
  if (threadId) {
    candidates.add(
      path.join(sessionsDir, `${sessionId}-topic-${encodeURIComponent(threadId)}.jsonl`),
    );
  }
  return [...candidates];
}

function readSessionStore(storePath: string): Record<string, SessionStoreEntry> {
  if (!existsSync(storePath)) {
    return {};
  }
  try {
    const parsed = JSON.parse(readFileSync(storePath, "utf8")) as UnknownRecord;
    const entries = Object.entries(parsed).filter(
      ([, value]) => value && typeof value === "object",
    );
    return Object.fromEntries(entries) as Record<string, SessionStoreEntry>;
  } catch {
    return {};
  }
}

export function listOpenClawSessionCandidates(
  cfg?: Record<string, unknown>,
): OpenClawSessionCandidate[] {
  const candidates: OpenClawSessionCandidate[] = [];
  for (const storePath of resolveSessionStorePaths(cfg)) {
    const store = readSessionStore(storePath);
    for (const [sessionKey, entry] of Object.entries(store)) {
      if (!isUserFacingSessionKey(sessionKey)) {
        continue;
      }
      const sessionId = normalizeNonEmptyString(entry.sessionId);
      const updatedAt = normalizeNumber(entry.updatedAt);
      const agentId =
        parseAgentIdFromSessionKey(sessionKey) ??
        path.basename(path.dirname(path.dirname(storePath)));
      if (!sessionId || !updatedAt || !agentId) {
        continue;
      }
      const transcriptCandidates = resolveTranscriptCandidates(storePath, sessionId, entry);
      const lastPreview = readLastTranscriptPreview(transcriptCandidates);
      const label =
        normalizeNonEmptyString(entry.displayName) ??
        normalizeNonEmptyString(entry.label) ??
        normalizeNonEmptyString(entry.subject) ??
        lastPreview ??
        sessionKey;
      const sessionFile = transcriptCandidates.find((candidate) => existsSync(candidate));
      candidates.push({
        sessionKey,
        agentId,
        sessionId,
        storePath,
        sessionFile,
        updatedAt,
        label,
        lastPreview,
        lastChannel: normalizeNonEmptyString(entry.lastChannel),
        lastTo: normalizeNonEmptyString(entry.lastTo),
        lastAccountId: normalizeNonEmptyString(entry.lastAccountId),
      });
    }
  }
  return [...candidates].sort(
    (left: OpenClawSessionCandidate, right: OpenClawSessionCandidate) =>
      right.updatedAt - left.updatedAt,
  );
}

export function findOpenClawSessionCandidate(
  sessionKey: string,
  cfg?: Record<string, unknown>,
): OpenClawSessionCandidate | null {
  const trimmed = sessionKey.trim();
  if (!trimmed) {
    return null;
  }
  return (
    listOpenClawSessionCandidates(cfg).find((candidate) => candidate.sessionKey === trimmed) ?? null
  );
}

function loadBindingsFile(): StoredBindingsFile {
  const filePath = resolveBindingsFilePath();
  if (!existsSync(filePath)) {
    return { version: 1, bindings: {} };
  }
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Partial<StoredBindingsFile>;
    if (parsed.version !== 1 || !parsed.bindings || typeof parsed.bindings !== "object") {
      return { version: 1, bindings: {} };
    }
    return { version: 1, bindings: parsed.bindings };
  } catch {
    return { version: 1, bindings: {} };
  }
}

function saveBindingsFile(next: StoredBindingsFile): void {
  const filePath = resolveBindingsFilePath();
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(next, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    chmodSync(filePath, 0o600);
  } catch {
    // Best-effort permission tightening.
  }
}

function resolveBindingKey(accountId: string, groupId: string): string {
  return `${accountId.trim() || "default"}:${groupId.trim()}`;
}

export function getChat4000SessionBinding(params: {
  accountId: string;
  groupId: string;
}): Chat4000SessionBinding | null {
  const key = resolveBindingKey(params.accountId, params.groupId);
  return loadBindingsFile().bindings[key] ?? null;
}

export function setChat4000SessionBinding(params: {
  accountId: string;
  groupId: string;
  target: OpenClawSessionCandidate;
}): Chat4000SessionBinding {
  const store = loadBindingsFile();
  const key = resolveBindingKey(params.accountId, params.groupId);
  const binding: Chat4000SessionBinding = {
    accountId: params.accountId,
    groupId: params.groupId,
    targetSessionKey: params.target.sessionKey,
    agentId: params.target.agentId,
    storePath: params.target.storePath,
    sessionId: params.target.sessionId,
    label: params.target.label,
    lastPreview: params.target.lastPreview,
    lastChannel: params.target.lastChannel,
    updatedAt: params.target.updatedAt,
    boundAt: new Date().toISOString(),
  };
  store.bindings[key] = binding;
  saveBindingsFile(store);
  return binding;
}

export function clearChat4000SessionBinding(params: {
  accountId: string;
  groupId: string;
}): boolean {
  const store = loadBindingsFile();
  const key = resolveBindingKey(params.accountId, params.groupId);
  if (!store.bindings[key]) {
    return false;
  }
  delete store.bindings[key];
  saveBindingsFile(store);
  return true;
}
