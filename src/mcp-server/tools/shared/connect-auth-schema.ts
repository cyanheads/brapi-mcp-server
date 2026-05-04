/**
 * @fileoverview Shared Zod discriminated union for BrAPI connection auth.
 * Used by `brapi_connect` and, later, by any tool that needs to accept an
 * inline auth payload.
 *
 * @module mcp-server/tools/shared/connect-auth-schema
 */

import { z } from '@cyanheads/mcp-ts-core';

export const ConnectAuthSchema = z
  .discriminatedUnion('mode', [
    z
      .object({ mode: z.literal('none').describe('No authentication.') })
      .describe('No-auth variant — public BrAPI endpoints.'),
    z
      .object({
        mode: z.literal('bearer').describe('Pre-obtained bearer token.'),
        token: z
          .string()
          .min(1)
          .describe('Pre-obtained access token, sent verbatim with each BrAPI request.'),
      })
      .describe('Bearer-token variant — caller already has an access token.'),
    z
      .object({
        mode: z.literal('api_key').describe('Static API key in a custom header.'),
        apiKey: z.string().min(1).describe('API key issued by the BrAPI server.'),
        headerName: z
          .string()
          .optional()
          .describe('HTTP header to send the API key in. Defaults to `Authorization`.'),
      })
      .describe('API-key variant — static key sent in a configurable header.'),
    z
      .object({
        mode: z
          .literal('sgn')
          .describe('Breedbase/SGN username+password; exchanged for a bearer token at /token.'),
        username: z.string().min(1).describe('SGN account username.'),
        password: z
          .string()
          .min(1)
          .describe('Password for the SGN/Breedbase username supplied above.'),
      })
      .describe('SGN variant — username/password exchanged at /token for a session bearer.'),
    z
      .object({
        mode: z
          .literal('oauth2')
          .describe(
            'OAuth2 client-credentials flow; exchanged for an access token at connect time.',
          ),
        clientId: z
          .string()
          .min(1)
          .describe('OAuth2 client identifier registered with the upstream IdP.'),
        clientSecret: z.string().min(1).describe('OAuth2 client secret paired with the clientId.'),
        tokenUrl: z
          .string()
          .url()
          .optional()
          .describe('OAuth2 token endpoint URL. Defaults derived from the base URL when omitted.'),
      })
      .describe('OAuth2 client-credentials variant.'),
  ])
  .describe(
    'Connection auth configuration. Discriminated by `mode`. Omit the entire `auth` field for no-auth servers.',
  );

export type ConnectAuthInput = z.infer<typeof ConnectAuthSchema>;
