// src/security/execution-lock.ts
// Prevents concurrent execution of the same job (double-spend guard)

const locks = new Map<string, NodeJS.Timeout>();

export function acquireLock(jobId: string): boolean {
  if (locks.has(jobId)) return false;
  // Defensive auto-release after 3 minutes in case of crash
  const timer = setTimeout(() => locks.delete(jobId), 3 * 60 * 1000);
  locks.set(jobId, timer);
  return true;
}

export function releaseLock(jobId: string): void {
  const timer = locks.get(jobId);
  if (timer) clearTimeout(timer);
  locks.delete(jobId);
}
