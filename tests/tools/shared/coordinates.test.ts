/**
 * @fileoverview Coordinate interpretation for location dialects and legacy records.
 * @module tests/tools/shared/coordinates.test
 */

import { describe, expect, it } from 'vitest';
import { extractCoordinates } from '@/mcp-server/tools/shared/find-helpers.js';

describe('extractCoordinates', () => {
  it('preserves spec coordinates and zero-valued legacy fields', () => {
    expect(
      extractCoordinates({ coordinates: { geometry: { type: 'Point', coordinates: [4, 7, 0] } } }),
    ).toEqual({ latitude: 7, longitude: 4, altitude: 0 });
    expect(extractCoordinates({ latitude: 0, longitude: 0, altitude: 0 }, 'swapped')).toEqual({
      latitude: 0,
      longitude: 0,
      altitude: 0,
    });
    expect(
      extractCoordinates({
        coordinates: {
          geometry: {
            type: 'Polygon',
            coordinates: [
              [
                [4, 7],
                [5, 8],
              ],
            ],
          },
        },
      }),
    ).toBeUndefined();
    expect(extractCoordinates({})).toBeUndefined();
  });

  it('swaps declared Point tuples without changing the raw record', () => {
    const record = { coordinates: { geometry: { type: 'Point', coordinates: [7, 4, 0] } } };
    expect(extractCoordinates(record, 'swapped')).toEqual({
      latitude: 7,
      longitude: 4,
      altitude: 0,
    });
    expect(record.coordinates.geometry.coordinates).toEqual([7, 4, 0]);
  });

  it('does not apply a Point dialect convention to an untyped coordinate tuple', () => {
    const record = { coordinates: { geometry: { coordinates: [4, 7] } } };
    expect(extractCoordinates(record)).toEqual({ latitude: 7, longitude: 4 });
    expect(extractCoordinates(record, 'swapped')).toEqual({ latitude: 7, longitude: 4 });
  });
});
