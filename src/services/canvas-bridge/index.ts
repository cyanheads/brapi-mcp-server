/**
 * @fileoverview Public barrel for the canvas-bridge service.
 *
 * @module services/canvas-bridge
 */

export {
  CanvasBridge,
  getCanvasBridge,
  initCanvasBridge,
  type RegisterDataframeInput,
  type RegisterDataframeResult,
  resetCanvasBridge,
} from './canvas-bridge.js';
export type { CanvasTableMeta, DescribedTable } from './types.js';
