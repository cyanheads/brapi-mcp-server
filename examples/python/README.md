# Python client example

[`brapi_mcp_client_demo.ipynb`](./brapi_mcp_client_demo.ipynb) drives this server from Python using the official
[`mcp`](https://pypi.org/project/mcp/) client SDK — connecting, finding studies, and running SQL against the
DuckDB-backed dataframe layer (`brapi_dataframe_describe` / `brapi_dataframe_query`).

## Running it

```sh
pip install mcp jupyter
jupyter notebook brapi_mcp_client_demo.ipynb
```

Requires Node.js or Bun on `PATH` — the notebook launches the server itself via `npx -y @cyanheads/brapi-mcp-server@latest`
(swap for `bunx` if you prefer Bun). No credentials needed; it connects to BrAPI's public test server by default.

## Why one `run_demo()` coroutine instead of one call per cell

`stdio_client`'s connection is an `anyio` task-group-based context manager, and anyio ties a task group to the asyncio
task that entered it. Opening the connection in one Jupyter cell and closing it in another means closing from a
different task than the one that opened it — which reliably hangs (reproduced with a minimal open-cell/close-cell
notebook; a single-cell `async with` closes in milliseconds). The notebook works around this by running the entire
session lifecycle inside one `run_demo()` coroutine invoked from a single cell, then displaying pieces of what it
collected from separate cells for readability.
