import { makeErrorResult } from "../validate.ts";

let activeSharedMutationToolCallId: string | undefined;

export function acquireSharedMutationLock(holderId: string): (() => void) | undefined {
  if (activeSharedMutationToolCallId) return undefined;

  activeSharedMutationToolCallId = holderId;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (activeSharedMutationToolCallId === holderId) activeSharedMutationToolCallId = undefined;
  };
}

export function sharedMutationBusyError(query: unknown): ReturnType<typeof makeErrorResult> {
  return makeErrorResult(
    "A shared-checkout mutating agent is already running. Wait for the current mutating agent to finish, or omit mutation for read-only runs that can go in parallel.",
    typeof query === "string" ? query : "",
  );
}
