import { renameSync, statSync, unlinkSync } from "node:fs";

const CHAT4000_LOG_MAX_BYTES = 10 * 1024 * 1024;

export function rotateLogIfOversized(
  logPath: string,
  pendingBytes: number,
  maxBytes: number = CHAT4000_LOG_MAX_BYTES,
): void {
  let currentSize = 0;
  try {
    currentSize = statSync(logPath).size;
  } catch {
    return;
  }
  if (currentSize + pendingBytes <= maxBytes) {
    return;
  }
  const archivePath = `${logPath}.1`;
  try {
    unlinkSync(archivePath);
  } catch {
    // No previous archive, ignore.
  }
  try {
    renameSync(logPath, archivePath);
  } catch {
    try {
      unlinkSync(logPath);
    } catch {
      // Best-effort: drop the rotation if neither rename nor unlink works.
    }
  }
}
