/**
 * @fileoverview Tests for the bounded-concurrency study fan-out helper
 * `pullObservationsForStudies`. Exercises the batching contract directly with an
 * injected fake per-study pull so timing, return values, and failures are fully
 * controlled: the concurrency bound is honored, outcomes come back in input
 * order regardless of completion order, per-study warnings stay isolated, and
 * the two failure policies (continue-on-error vs fail-fast short-circuit)
 * behave as the two consuming tools require.
 *
 * @module tests/tools/shared/observations.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import type { ServerConfig } from '@/config/server-config.js';
import {
  type NormObs,
  type PullObservationsForStudiesArgs,
  type PullStudyObservationsArgs,
  pullObservationsForStudies,
} from '@/mcp-server/tools/shared/observations.js';
import type { BrapiClient } from '@/services/brapi-client/index.js';
import type { BrapiDialect } from '@/services/brapi-dialect/index.js';
import type { RegisteredServer } from '@/services/server-registry/index.js';

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A NormObs stamped with its source study, so input-order assertions trace each row back. */
function obs(studyDbId: string): NormObs {
  return {
    germplasmDbId: 'g1',
    germplasmName: 'G1',
    observationVariableDbId: 'v1',
    observationVariableName: 'V1',
    studyDbId,
    value: '1',
  };
}

/**
 * Build the shared args. `client` / `connection` / `dialect` / `profile` / `input`
 * are never touched by the injected fake pull, so placeholder values suffice —
 * only `config.maxConcurrentRequests` and `ctx.signal` drive the helper itself.
 */
function baseArgs(
  studyDbIds: string[],
  maxConcurrentRequests: number,
  failFast: boolean,
  ctx = createMockContext(),
): PullObservationsForStudiesArgs {
  return {
    studyDbIds,
    input: {},
    client: {} as BrapiClient,
    connection: {} as RegisteredServer,
    dialect: {} as BrapiDialect,
    profile: {},
    loadLimit: 10,
    config: { maxConcurrentRequests } as ServerConfig,
    ctx,
    failFast,
  };
}

describe('pullObservationsForStudies', () => {
  it('runs studies in bounded-concurrency batches — never more than maxConcurrentRequests in flight', async () => {
    const studyDbIds = ['s0', 's1', 's2', 's3', 's4', 's5'];
    let inFlight = 0;
    let peak = 0;
    const pull = async (a: PullStudyObservationsArgs): Promise<NormObs[] | null> => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await delay(15);
      inFlight--;
      return [obs(a.studyDbId)];
    };

    const outcomes = await pullObservationsForStudies(baseArgs(studyDbIds, 2, false), pull);

    // Exactly 2 proves BOTH the bound (never 3) and real parallelism (never 1,
    // which is what a sequential pre-fix pull would produce).
    expect(peak).toBe(2);
    expect(outcomes).toHaveLength(6);
  });

  it('reassembles outcomes in input order even when later studies resolve first', async () => {
    const studyDbIds = ['s0', 's1', 's2', 's3'];
    const pull = async (a: PullStudyObservationsArgs): Promise<NormObs[] | null> => {
      // Reverse the completion order within the single batch: s0 finishes last.
      const idx = studyDbIds.indexOf(a.studyDbId);
      await delay((studyDbIds.length - idx) * 8);
      return [obs(a.studyDbId)];
    };

    const outcomes = await pullObservationsForStudies(baseArgs(studyDbIds, 4, false), pull);

    expect(outcomes.map((o) => o.studyDbId)).toEqual(studyDbIds);
    expect(outcomes.map((o) => o.observations?.[0]?.studyDbId)).toEqual(studyDbIds);
  });

  it('continue-on-error: one study throwing does not abort or lose the rest of the batch', async () => {
    const studyDbIds = ['s0', 'bad', 's2'];
    const pull = async (a: PullStudyObservationsArgs): Promise<NormObs[] | null> => {
      if (a.studyDbId === 'bad') throw new Error('boom');
      return [obs(a.studyDbId)];
    };

    const outcomes = await pullObservationsForStudies(baseArgs(studyDbIds, 4, false), pull);

    expect(outcomes.map((o) => o.studyDbId)).toEqual(['s0', 'bad', 's2']);
    expect(outcomes[0]?.observations).toEqual([obs('s0')]);
    expect(outcomes[1]?.error).toBeInstanceOf(Error);
    expect(outcomes[1]?.observations).toBeNull();
    expect(outcomes[2]?.observations).toEqual([obs('s2')]);
  });

  it('surfaces the null no-observation-path sentinel without treating it as an error', async () => {
    const studyDbIds = ['s0', 's1'];
    const pull = async (a: PullStudyObservationsArgs): Promise<NormObs[] | null> =>
      a.studyDbId === 's1' ? null : [obs(a.studyDbId)];

    const outcomes = await pullObservationsForStudies(baseArgs(studyDbIds, 4, false), pull);

    expect(outcomes[1]?.observations).toBeNull();
    expect(outcomes[1]?.error).toBeUndefined();
  });

  it('fail-fast: stops after the batch with the first failing study — later studies are never pulled', async () => {
    const studyDbIds = ['s0', 's1', 's2', 's3', 's4', 's5'];
    const pulled: string[] = [];
    const pull = async (a: PullStudyObservationsArgs): Promise<NormObs[] | null> => {
      pulled.push(a.studyDbId);
      return a.studyDbId === 's0' ? null : [obs(a.studyDbId)];
    };

    const outcomes = await pullObservationsForStudies(baseArgs(studyDbIds, 2, true), pull);

    // Batch 1 = [s0, s1]; s0 has no path → stop. Batches 2+ are never launched.
    expect(outcomes.map((o) => o.studyDbId)).toEqual(['s0', 's1']);
    expect([...pulled].sort()).toEqual(['s0', 's1']);
  });

  it('continue-on-error pulls every study even when an early one fails (the fail-fast contrast)', async () => {
    const studyDbIds = ['s0', 's1', 's2', 's3', 's4', 's5'];
    const pulled: string[] = [];
    const pull = async (a: PullStudyObservationsArgs): Promise<NormObs[] | null> => {
      pulled.push(a.studyDbId);
      return a.studyDbId === 's0' ? null : [obs(a.studyDbId)];
    };

    const outcomes = await pullObservationsForStudies(baseArgs(studyDbIds, 2, false), pull);

    expect(outcomes).toHaveLength(6);
    expect([...pulled].sort()).toEqual(['s0', 's1', 's2', 's3', 's4', 's5']);
  });

  it("keeps each study's warnings in its own outcome (no cross-study interleave)", async () => {
    const studyDbIds = ['s0', 's1'];
    const pull = async (a: PullStudyObservationsArgs): Promise<NormObs[] | null> => {
      a.warnings.push(`warn:${a.studyDbId}`);
      return [obs(a.studyDbId)];
    };

    const outcomes = await pullObservationsForStudies(baseArgs(studyDbIds, 4, false), pull);

    expect(outcomes[0]?.warnings).toEqual(['warn:s0']);
    expect(outcomes[1]?.warnings).toEqual(['warn:s1']);
  });

  it('stops launching batches when the context is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const args = baseArgs(['s0', 's1'], 2, false, createMockContext({ signal: controller.signal }));
    const pulled: string[] = [];
    const pull = async (a: PullStudyObservationsArgs): Promise<NormObs[] | null> => {
      pulled.push(a.studyDbId);
      return [obs(a.studyDbId)];
    };

    const outcomes = await pullObservationsForStudies(args, pull);

    expect(outcomes).toHaveLength(0);
    expect(pulled).toHaveLength(0);
  });
});
