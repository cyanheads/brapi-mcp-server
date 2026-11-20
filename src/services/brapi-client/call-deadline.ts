/**
 * @fileoverview The call-wide deadline for upstream BrAPI requests. Every
 * request one tool call makes — each attempt, backoff, poll, and chained
 * request — shares one deadline measured from the call's start
 * (`ctx.timestamp`). It ends under the MCP SDK client's 60 s default request
 * timeout, so a stalled upstream surfaces as this server's `Timeout` with a
 * recovery hint instead of a client-side timeout.
 *
 * @module services/brapi-client/call-deadline
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { type McpError, timeout } from '@cyanheads/mcp-ts-core/errors';

/** `data.reason` on a request the call deadline cut short or never sent. */
export const CALL_DEADLINE_REASON = 'call_deadline_exceeded';

/** Recovery hint on every `Timeout` the client surfaces. */
export const UPSTREAM_TIMEOUT_HINT =
  'The BrAPI endpoint is slow or not answering. Retry later, or reduce the amount of data requested from that endpoint.';

const CALL_DEADLINE_HINT =
  'The BrAPI server is slow or not answering. Retry later, or narrow the request so the call needs fewer upstream requests.';

/** Epoch ms at which the call `ctx` belongs to stops waiting on upstream requests. */
export function callDeadlineAt(ctx: Pick<Context, 'timestamp'>, callDeadlineMs: number): number {
  return Date.parse(ctx.timestamp) + callDeadlineMs;
}

/**
 * The `Timeout` for a request the call deadline ended (`sent`) or kept from
 * starting. Names the call deadline, never the slice of it the request had.
 */
export function callDeadlineExceeded(
  operation: string,
  callDeadlineMs: number,
  details: { sent: boolean; retryAttempts?: number; primaryRead?: boolean },
  cause?: unknown,
): McpError {
  const seconds = callDeadlineMs / 1000;
  const attempts =
    details.retryAttempts && details.retryAttempts > 1
      ? ` (${details.retryAttempts} attempts)`
      : '';
  const message = details.sent
    ? `${operation} did not finish within this call's ${seconds} s deadline for upstream requests${attempts}.`
    : `${operation} was not sent: this call's ${seconds} s deadline for upstream requests had passed.`;
  return timeout(
    message,
    {
      reason: CALL_DEADLINE_REASON,
      callDeadlineMs,
      operation,
      ...(details.retryAttempts !== undefined && { retryAttempts: details.retryAttempts }),
      recovery: { hint: details.primaryRead ? UPSTREAM_TIMEOUT_HINT : CALL_DEADLINE_HINT },
    },
    cause === undefined ? undefined : { cause },
  );
}
