# `paulcam206/copilot-api`

This fork exists to support long-running benchmark campaigns that use GitHub
Copilot through an OpenAI-compatible local proxy.

## Differences from `ericc-ch/copilot-api@0.7.0`

- Models whose upstream `supported_endpoints` contains `/responses` but not
  `/chat/completions` are translated internally through Copilot's Responses
  API. The public Chat Completions contract remains unchanged.
- `GET /models` and `GET /v1/models` expose `supported_endpoints`. A `null`
  value means the upstream catalog did not report the capability; it does not
  mean Chat Completions is supported.
- `--version` prints the package version and exits without starting the server.

The Responses translation began with
[`ericc-ch/copilot-api#274`](https://github.com/ericc-ch/copilot-api/pull/274).
This fork also addresses its review findings: multiple-choice requests are
rejected rather than truncated, failed Responses remain failures, unknown
output items do not become malformed tool calls, and image requests set the
Copilot vision header.

## GitHub-token lifetime

The configured GitHub App (`Iv1.b507a08c87ecfe98`) was tested through its real
device flow. Its token response contained only `access_token`, `scope`, and
`token_type`; it did not contain `refresh_token` or expiry fields.

GitHub only permits rotating an expiring user access token when the app issues
a refresh token. Consequently, this fork cannot renew that credential. The
existing loud failure is deliberately preserved: a campaign must become
blocked rather than continue with plausible but invalid measurements. Durable
renewal requires the GitHub App owner to enable expiring user authorization
tokens and issue a refresh token, or a different authentication mechanism.

## Consumer contract

The benchmark fleet depends on these behaviors:

- the authentication subcommand remains `auth`;
- the access token remains at
  `<home>/.local/share/copilot-api/github_token`;
- the server honors `HOST`; the fleet sets it to `127.0.0.1`;
- the executable remains `dist/main.js`;
- `--version` writes only the version to stdout;
- `/token` and `/usage` remain sensitive and must not be guest-accessible.

## Build and validation

```console
bun install --frozen-lockfile
bun run typecheck
bun test
bun run lint:all
bun run build
node dist/main.js --version
```

Real validation requires an isolated `HOME` and `USERPROFILE`. Authenticate
with `node dist/main.js auth`, start with `HOST=127.0.0.1`, and send real
non-streaming requests through `POST /v1/chat/completions`.

Validated model behavior:

| Model | Catalog endpoints | Result |
|---|---|---|
| `gpt-5.6-terra` | `/responses`, `ws:/responses` | HTTP 200 |
| `gpt-5.5` | `/responses`, `ws:/responses` | HTTP 200 |
| `gpt-5.6-sol` | `/responses`, `ws:/responses` | HTTP 200 |
| `claude-sonnet-5` | `/v1/messages`, `/chat/completions` | HTTP 200 |
| `gpt-5.4` | `/responses`, `/chat/completions`, `ws:/responses` | HTTP 400 `Bad Request` |

`gpt-5.4` is a separate upstream behavior: the catalog advertises Chat
Completions, so the proxy correctly selects that endpoint, but Copilot returns
only a generic `Bad Request`. Do not classify it as
`unsupported_api_for_model` without better upstream diagnostics.

## Repointing the benchmark fleet later

Fleet adoption is intentionally deferred. When adopting this fork:

1. Pin an immutable fork commit or release in the fleet's dependency lock.
2. Keep the installed package directory at `node_modules/copilot-api` and the
   executable at `node_modules/copilot-api/dist/main.js`, or update the
   consumer validation deliberately.
3. Update the configured version and SHA-256 hashes for both `dist/main.js`
   and the dependency lock.
4. Install in the fleet's isolated Node 22 tool home.
5. Run the fleet installation check, authentication probe, and real model
   requests before starting a campaign.

No gateway allowlist change is needed: Responses routing is internal, while
clients continue to call `POST /v1/chat/completions`.
