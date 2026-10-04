/**
 * @fileoverview Reads a resource definition through the framework's resource
 * factory. A direct `definition.handler(...)` call returns the throw site's
 * `McpError` as built — the factory is what fills a declared reason's
 * `data.recovery.hint` — so contract-hint assertions go through here. Serves
 * the definition from `createWorkerHandler` and sends one `resources/read`
 * JSON-RPC request at protocol revision 2026-07-28.
 *
 * @module tests/resources/_resource-factory
 */

import { createWorkerHandler } from '@cyanheads/mcp-ts-core/worker';

type AnyResourceDefinition = NonNullable<
  NonNullable<Parameters<typeof createWorkerHandler>[0]>['resources']
>[number];

const PROTOCOL_VERSION = '2026-07-28';

/** JSON-RPC error a `resources/read` answered with. */
export interface ResourceReadError {
  code: number;
  data?: Record<string, unknown>;
  message: string;
}

/** Sends `resources/read` for `uri` and returns the response's JSON-RPC `error`. */
export async function readResourceError(
  definition: AnyResourceDefinition,
  uri: string,
): Promise<ResourceReadError | undefined> {
  const handler = createWorkerHandler({
    name: 'brapi-mcp-server',
    title: 'brapi-mcp-server',
    resources: [definition],
  });
  const request = new Request('http://localhost/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': PROTOCOL_VERSION,
      'mcp-method': 'resources/read',
      'mcp-name': uri,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'resources/read',
      params: {
        uri,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': PROTOCOL_VERSION,
          'io.modelcontextprotocol/clientCapabilities': {},
          'io.modelcontextprotocol/clientInfo': { name: 'test', version: '0' },
        },
      },
    }),
  });
  const response = await handler.fetch(
    request,
    {} as never,
    {
      waitUntil() {},
      passThroughOnException() {},
    } as never,
  );
  const text = await response.text();
  const json = text.startsWith('{')
    ? text
    : (text
        .split('\n')
        .find((line) => line.startsWith('data:'))
        ?.slice('data:'.length)
        .trim() ?? '{}');
  return (JSON.parse(json) as { error?: ResourceReadError }).error;
}
