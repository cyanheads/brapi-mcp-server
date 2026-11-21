/**
 * @fileoverview Whether a capability descriptor serves an HTTP method.
 *
 * @module services/capability-registry/supports-method
 */

/**
 * True when `descriptor` is listed and serves `method`; a listing without
 * methods serves every method.
 */
export function supportsMethod(
  descriptor: { methods?: readonly string[] } | undefined,
  method: string,
): boolean {
  if (!descriptor) return false;
  return !descriptor.methods?.length || descriptor.methods.includes(method);
}
