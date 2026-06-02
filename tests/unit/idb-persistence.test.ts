import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { persistIdbToDisk, restoreIdbFromDisk } from "../../src/matrix/idb-persistence.js";

const DB_NAME = "chat4000-test::crypto";

function idbErr(error: DOMException | null): Error {
  return error ?? new Error("IndexedDB request failed");
}

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(idbErr(r.error));
  });
}

function openCreating(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore("s", { keyPath: "id" });
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(idbErr(r.error));
  });
}

function openExisting(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(idbErr(r.error));
  });
}

async function readRecord(db: IDBDatabase, id: string): Promise<unknown> {
  return req(db.transaction("s", "readonly").objectStore("s").get(id));
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "c4k-idb-"));
});

afterEach(async () => {
  await req(indexedDB.deleteDatabase(DB_NAME)).catch(() => undefined);
  rmSync(dir, { recursive: true, force: true });
});

describe("crypto store persistence", () => {
  it("round-trips records through a disk snapshot", async () => {
    const snapshotPath = path.join(dir, "snap.json");

    const db1 = await openCreating();
    await req(db1.transaction("s", "readwrite").objectStore("s").put({ id: "k1", secret: 42 }));
    db1.close();

    await persistIdbToDisk({ snapshotPath, databasePrefix: "chat4000-test" });

    // Wipe the in-memory database, then restore from disk.
    await req(indexedDB.deleteDatabase(DB_NAME));
    const restored = await restoreIdbFromDisk(snapshotPath);
    expect(restored).toBe(true);

    const db2 = await openExisting();
    expect(await readRecord(db2, "k1")).toEqual({ id: "k1", secret: 42 });
    db2.close();
  });

  it("returns false for a missing snapshot (fresh start)", async () => {
    expect(await restoreIdbFromDisk(path.join(dir, "nope.json"))).toBe(false);
  });
});
