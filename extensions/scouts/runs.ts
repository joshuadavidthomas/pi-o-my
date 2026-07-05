import { randomBytes } from "node:crypto";

import type { AgentSession } from "@earendil-works/pi-coding-agent";

import type { ScoutDetails } from "./types.ts";

type ScoutRunDetails = ScoutDetails["runs"][number];

export type SuspendReason = "timeout" | "more_time_requested";
export type TakeSuspendedRunFailureReason = "not_found" | "expired";

export interface SuspendedRunEntry {
  runId: string;
  session: AgentSession;
  configName: string;
  toolName: string;
  isMutatingWorker: boolean;
  modelInfo: string;
  runDetails: ScoutRunDetails;
  suspendedAt: number;
  suspendReason: SuspendReason;
  timeoutMs: number;
  expiresAt: number;
}

export type SuspendedRunInput = Omit<SuspendedRunEntry, "suspendedAt" | "expiresAt"> & Partial<Pick<SuspendedRunEntry, "suspendedAt">>;

export interface SuspendedRunStatus {
  runId: string;
  configName: string;
  toolName: string;
  isMutatingWorker: boolean;
  modelInfo: string;
  suspendedAt: number;
  suspendReason: SuspendReason;
  timeoutMs: number;
  expiresAt: number;
  status: ScoutRunDetails["status"];
  query: string;
  turns: number;
  activityText?: string;
  summaryText?: string;
  error?: string;
}

export type TakeSuspendedRunResult =
  | { ok: true; entry: SuspendedRunEntry }
  | { ok: false; reason: TakeSuspendedRunFailureReason };

const MAX_SUSPENDED_RUNS = 5;
const SUSPENDED_RUN_TTL_MS = 30 * 60 * 1000;
const SUSPENDED_RUN_SWEEP_MS = 5 * 60 * 1000;

const suspendedRuns = new Map<string, SuspendedRunEntry>();
const issuedRunIds = new Set<string>();

export function generateRunId(prefix: string): string {
  const safePrefix = prefix.replace(/[^a-z0-9]/gi, "").toLowerCase().slice(0, 6) || "run";

  while (true) {
    const suffix = randomBytes(3).toString("hex");
    const runId = `${safePrefix}-${suffix}`;
    if (issuedRunIds.has(runId) || suspendedRuns.has(runId)) continue;
    issuedRunIds.add(runId);
    return runId;
  }
}

export function suspendRun(input: SuspendedRunInput): SuspendedRunEntry {
  expireSuspendedRuns(Date.now());

  const suspendedAt = input.suspendedAt ?? Date.now();
  const entry: SuspendedRunEntry = {
    ...input,
    suspendedAt,
    expiresAt: suspendedAt + SUSPENDED_RUN_TTL_MS,
  };

  const previous = suspendedRuns.get(entry.runId);
  if (previous && previous.session !== entry.session) disposeSession(previous.session);

  suspendedRuns.delete(entry.runId);
  suspendedRuns.set(entry.runId, entry);
  enforceSuspendedRunCap();
  return entry;
}

export function takeRunForResume(runId: string): TakeSuspendedRunResult {
  const entry = suspendedRuns.get(runId);
  if (!entry) return { ok: false, reason: "not_found" };

  suspendedRuns.delete(runId);
  if (isExpired(entry, Date.now())) {
    disposeSession(entry.session);
    return { ok: false, reason: "expired" };
  }

  return { ok: true, entry };
}

export function getSuspendedRun(runId: string): SuspendedRunEntry | undefined {
  const entry = suspendedRuns.get(runId);
  if (!entry) return undefined;

  if (isExpired(entry, Date.now())) {
    suspendedRuns.delete(runId);
    disposeSession(entry.session);
    return undefined;
  }

  suspendedRuns.delete(runId);
  suspendedRuns.set(runId, entry);
  return entry;
}

export function listSuspendedRuns(): SuspendedRunStatus[] {
  expireSuspendedRuns(Date.now());
  return [...suspendedRuns.values()].map(toStatus);
}

export function disposeSuspendedRun(runId: string): boolean {
  const entry = suspendedRuns.get(runId);
  if (!entry) return false;

  suspendedRuns.delete(runId);
  disposeSession(entry.session);
  return true;
}

function enforceSuspendedRunCap(): void {
  while (suspendedRuns.size > MAX_SUSPENDED_RUNS) {
    const oldestRunId = suspendedRuns.keys().next().value;
    if (!oldestRunId) return;
    disposeSuspendedRun(oldestRunId);
  }
}

function expireSuspendedRuns(now: number): void {
  for (const [runId, entry] of suspendedRuns) {
    if (!isExpired(entry, now)) continue;
    suspendedRuns.delete(runId);
    disposeSession(entry.session);
  }
}

function isExpired(entry: SuspendedRunEntry, now: number): boolean {
  return entry.expiresAt <= now;
}

function disposeSession(session: AgentSession): void {
  try {
    session.dispose();
  } catch {
  }
}

function toStatus(entry: SuspendedRunEntry): SuspendedRunStatus {
  return {
    runId: entry.runId,
    configName: entry.configName,
    toolName: entry.toolName,
    isMutatingWorker: entry.isMutatingWorker,
    modelInfo: entry.modelInfo,
    suspendedAt: entry.suspendedAt,
    suspendReason: entry.suspendReason,
    timeoutMs: entry.timeoutMs,
    expiresAt: entry.expiresAt,
    status: entry.runDetails.status,
    query: entry.runDetails.query,
    turns: entry.runDetails.turns,
    activityText: entry.runDetails.activityText,
    summaryText: entry.runDetails.summaryText,
    error: entry.runDetails.error,
  };
}

const sweepTimer = setInterval(() => {
  expireSuspendedRuns(Date.now());
}, SUSPENDED_RUN_SWEEP_MS);
sweepTimer.unref?.();
