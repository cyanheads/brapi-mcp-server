/**
 * @fileoverview Public barrel for the canvas-bridge service.
 *
 * @module services/canvas-bridge
 */

export {
  CanvasBridge,
  datasetTableName,
  getCanvasBridge,
  initCanvasBridge,
  resetCanvasBridge,
  tableNameToDatasetId,
} from './canvas-bridge.js';
export type { CanvasTableMeta, DescribedTable } from './types.js';
