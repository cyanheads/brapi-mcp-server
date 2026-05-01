# BrAPI Server Compatibility

Probed: 2026-05-01

This matrix records live `/serverinfo` capability probes against representative
public BrAPI v2 servers. It is evidence for routing and dialect behavior, not a
guarantee that every endpoint on a server returns useful data for every filter.

Source for public endpoint inventory: [brapi.org/servers](https://brapi.org/servers).

| Server | Base URL | Auth | Detected Dialect | Advertised Calls | Curated Coverage | Notes |
|:--|:--|:--|:--|--:|:--|:--|
| BrAPI Community Test Server | `https://test-server.brapi.org/brapi/v2` | None for reads | `brapi-test` | 148 | studies, germplasm, observations, variables, locations, images, variants, genotype calls | Full curated read coverage advertised. Location bbox logic may need swapped GeoJSON axes; the dialect surfaces that quirk. |
| CassavaBase | `https://cassavabase.org/brapi/v2` | Optional SGN for protected data | `cassavabase` | 118 | studies, germplasm, observations, variables, locations, images, variants, genotype calls | SGN-family singular GET filters; advertised POST `/search/*` routes are routed around for curated read nouns. |
| SweetpotatoBase | `https://sweetpotatobase.org/brapi/v2` | Optional SGN for protected data | `breedbase` | 118 | studies, germplasm, observations, variables, locations, images, variants, genotype calls | Breedbase/SGN behavior: singular GET filters and known-dead search routes for read nouns. |
| T3/Wheat | `https://wheat.triticeaetoolbox.org/brapi/v2` | None for public reads | `breedbase` | 118 | studies, germplasm, observations, variables, locations, images, variants, genotype calls | Hosted on the Breedbase/SGN stack; same dialect family as SweetpotatoBase. |
| FAIDARE / GnpIS | `https://urgi.versailles.inrae.fr/faidare/brapi/v2` | None for probed reads | `spec` | 4 | germplasm only | Partial server surface. `brapi_find_germplasm` can use GET `/germplasm` or POST `/search/germplasm`; other curated tools should fail early with a capability error. |

## Routing Rules Verified

- Curated `find_*` tools prefer advertised GET list endpoints.
- If GET is not advertised but POST `/search/{noun}` is advertised, the tool sends the same semantic filters as a search body and records a route-selection warning.
- If the active dialect marks a search noun as known-dead, search fallback is refused with an actionable validation error.
- If neither GET nor search is advertised, the tool fails before touching the upstream endpoint.

## Probe Command

```bash
curl -L -sS "$BASE_URL/serverinfo" \
  | jq '[.result.calls[]?.service] as $s | {calls: ($s | length), curated: {
      studies: ($s | index("studies") != null),
      germplasm: ($s | index("germplasm") != null),
      observations: ($s | index("observations") != null),
      variables: ($s | index("variables") != null),
      locations: ($s | index("locations") != null),
      images: ($s | index("images") != null),
      variants: ($s | index("variants") != null),
      calls: ($s | index("search/calls") != null)
    }}'
```
