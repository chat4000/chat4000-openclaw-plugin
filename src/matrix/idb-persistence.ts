/**
 * Disk persistence for the in-memory (fake-indexeddb) Rust crypto store.
 *
 * matrix-js-sdk's Rust crypto keeps its Olm/Megolm/device state in IndexedDB.
 * Under Node we back IndexedDB with `fake-indexeddb` (in-memory), so without this
 * the crypto store is lost on every restart — the bot re-keys and looks like a
 * brand-new device. This module snapshots the IndexedDB databases to a JSON file
 * and restores them on boot, giving a durable crypto identity across restarts.
 *
 * Ported from the @openclaw/matrix reference (`matrix/sdk/idb-persistence.ts`).
 * The exported `indexedDB` singleton IS the same instance `fake-indexeddb/auto`
 * installs as `globalThis.indexedDB`, so a snapshot here sees the SDK's data.
 *
 * Safety: writes are atomic (temp file + rename); a malformed/partial snapshot is
 * rejected and the bot simply starts fresh (re-keys) rather than loading corrupt
 * crypto state. We do NOT encrypt the snapshot — it lives under the 0700-ish
 * OpenClaw state dir alongside the credentials file, and is chmod 0600.
 */
import fs from "node:fs";
import path from "node:path";
import { indexedDB as fakeIndexedDB } from "fake-indexeddb";

type Logger = (line: string) => void;

/** Coerce an IndexedDB request error (DOMException | null) into a real Error. */
function idbError(error: DOMException | null): Error {
  return error ?? new Error("IndexedDB request failed");
}

type IdbStoreSnapshot = {
  name: string;
  keyPath: IDBObjectStoreParameters["keyPath"];
  autoIncrement: boolean;
  indexes: { name: string; keyPath: string | string[]; multiEntry: boolean; unique: boolean }[];
  records: { key: IDBValidKey; value: unknown }[];
};

type IdbDatabaseSnapshot = {
  name: string;
  version: number;
  stores: IdbStoreSnapshot[];
};

function isValidIdbIndexSnapshot(value: unknown): value is IdbStoreSnapshot["indexes"][number] {
  if (!value || typeof value !== "object") return false;
  const c = value as Partial<IdbStoreSnapshot["indexes"][number]>;
  return (
    typeof c.name === "string" &&
    (typeof c.keyPath === "string" ||
      (Array.isArray(c.keyPath) && c.keyPath.every((e) => typeof e === "string"))) &&
    typeof c.multiEntry === "boolean" &&
    typeof c.unique === "boolean"
  );
}

function isValidIdbRecordSnapshot(value: unknown): value is IdbStoreSnapshot["records"][number] {
  if (!value || typeof value !== "object") return false;
  return "key" in value && "value" in value;
}

function isValidIdbStoreSnapshot(value: unknown): value is IdbStoreSnapshot {
  if (!value || typeof value !== "object") return false;
  const c = value as Partial<IdbStoreSnapshot>;
  const validKeyPath =
    c.keyPath === null ||
    typeof c.keyPath === "string" ||
    (Array.isArray(c.keyPath) && c.keyPath.every((e) => typeof e === "string"));
  return (
    typeof c.name === "string" &&
    validKeyPath &&
    typeof c.autoIncrement === "boolean" &&
    Array.isArray(c.indexes) &&
    c.indexes.every((e) => isValidIdbIndexSnapshot(e)) &&
    Array.isArray(c.records) &&
    c.records.every((e) => isValidIdbRecordSnapshot(e))
  );
}

function isValidIdbDatabaseSnapshot(value: unknown): value is IdbDatabaseSnapshot {
  if (!value || typeof value !== "object") return false;
  const c = value as Partial<IdbDatabaseSnapshot>;
  return (
    typeof c.name === "string" &&
    typeof c.version === "number" &&
    Number.isFinite(c.version) &&
    c.version > 0 &&
    Array.isArray(c.stores) &&
    c.stores.every((e) => isValidIdbStoreSnapshot(e))
  );
}

function parseSnapshotPayload(data: string): IdbDatabaseSnapshot[] | null {
  const parsed = JSON.parse(data) as unknown;
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  if (!parsed.every((e) => isValidIdbDatabaseSnapshot(e))) {
    throw new Error("malformed IndexedDB snapshot payload");
  }
  return parsed;
}

function idbReq<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.addEventListener("success", () => resolve(req.result), { once: true });
    req.addEventListener("error", () => reject(idbError(req.error)), { once: true });
  });
}

async function dumpIndexedDatabases(databasePrefix?: string): Promise<IdbDatabaseSnapshot[]> {
  const idb = fakeIndexedDB;
  const dbList = await idb.databases();
  const snapshot: IdbDatabaseSnapshot[] = [];
  const expectedPrefix = databasePrefix ? `${databasePrefix}::` : null;

  for (const { name, version } of dbList) {
    if (!name || !version) continue;
    if (expectedPrefix && !name.startsWith(expectedPrefix)) continue;
    const db: IDBDatabase = await new Promise((resolve, reject) => {
      const r = idb.open(name, version);
      r.addEventListener("success", () => resolve(r.result), { once: true });
      r.addEventListener("error", () => reject(idbError(r.error)), { once: true });
    });

    const stores: IdbStoreSnapshot[] = [];
    for (const storeName of db.objectStoreNames) {
      const tx = db.transaction(storeName, "readonly");
      const store = tx.objectStore(storeName);
      const storeInfo: IdbStoreSnapshot = {
        name: storeName,
        keyPath: store.keyPath,
        autoIncrement: store.autoIncrement,
        indexes: [],
        records: [],
      };
      for (const idxName of store.indexNames) {
        const idx = store.index(idxName);
        storeInfo.indexes.push({
          name: idxName,
          keyPath: idx.keyPath,
          multiEntry: idx.multiEntry,
          unique: idx.unique,
        });
      }
      const keys = await idbReq(store.getAllKeys());
      const values: unknown[] = await idbReq<unknown[]>(store.getAll());
      storeInfo.records = keys.map((k, i) => ({ key: k, value: values[i] }));
      stores.push(storeInfo);
    }
    snapshot.push({ name, version, stores });
    db.close();
  }
  return snapshot;
}

async function restoreIndexedDatabases(snapshot: IdbDatabaseSnapshot[]): Promise<void> {
  const idb = fakeIndexedDB;
  for (const dbSnap of snapshot) {
    await new Promise<void>((resolve, reject) => {
      const r = idb.open(dbSnap.name, dbSnap.version);
      r.addEventListener("upgradeneeded", () => {
        const db = r.result;
        for (const storeSnap of dbSnap.stores) {
          const opts: IDBObjectStoreParameters = {};
          if (storeSnap.keyPath !== null && storeSnap.keyPath !== undefined) {
            opts.keyPath = storeSnap.keyPath;
          }
          if (storeSnap.autoIncrement) opts.autoIncrement = true;
          const store = db.createObjectStore(storeSnap.name, opts);
          for (const idx of storeSnap.indexes) {
            store.createIndex(idx.name, idx.keyPath, {
              unique: idx.unique,
              multiEntry: idx.multiEntry,
            });
          }
        }
      });
      r.addEventListener(
        "success",
        () => {
          void (async () => {
            const db = r.result;
            for (const storeSnap of dbSnap.stores) {
              if (storeSnap.records.length === 0) continue;
              const tx = db.transaction(storeSnap.name, "readwrite");
              const store = tx.objectStore(storeSnap.name);
              for (const rec of storeSnap.records) {
                if (storeSnap.keyPath !== null) store.put(rec.value);
                else store.put(rec.value, rec.key);
              }
              await new Promise<void>((res) => {
                tx.addEventListener("complete", () => res(), { once: true });
              });
            }
            db.close();
            resolve();
          })().catch(reject);
        },
        { once: true },
      );
      r.addEventListener("error", () => reject(idbError(r.error)), { once: true });
    });
  }
}

/** Restore the crypto store from `snapshotPath`. Returns false (fresh) on any error. */
export async function restoreIdbFromDisk(snapshotPath: string, log?: Logger): Promise<boolean> {
  try {
    if (!fs.existsSync(snapshotPath)) return false;
    const snapshot = parseSnapshotPayload(fs.readFileSync(snapshotPath, "utf8"));
    if (!snapshot) return false;
    await restoreIndexedDatabases(snapshot);
    log?.(`restored ${snapshot.length} crypto IndexedDB database(s) from disk`);
    return true;
  } catch (err) {
    log?.(`crypto store restore failed (starting fresh): ${String(err)}`);
    return false;
  }
}

/** Snapshot the crypto store to `snapshotPath` atomically. Best-effort. */
export async function persistIdbToDisk(params: {
  snapshotPath: string;
  databasePrefix?: string;
  log?: Logger;
}): Promise<void> {
  try {
    const snapshot = await dumpIndexedDatabases(params.databasePrefix);
    if (snapshot.length === 0) return;
    fs.mkdirSync(path.dirname(params.snapshotPath), { recursive: true });
    const tmp = `${params.snapshotPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(snapshot), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, params.snapshotPath); // atomic replace
    try {
      fs.chmodSync(params.snapshotPath, 0o600);
    } catch {
      // best-effort
    }
    params.log?.(`persisted ${snapshot.length} crypto IndexedDB database(s)`);
  } catch (err) {
    params.log?.(`crypto store persist failed: ${String(err)}`);
  }
}

/** Default 60s persist cadence (matches the reference). */
export const IDB_PERSIST_INTERVAL_MS = 60_000;
