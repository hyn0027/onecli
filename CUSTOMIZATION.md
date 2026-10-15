# Local customizations

This checkout runs as the OneCLI instance behind a local NanoClaw install
(`~/Documents/Research/nanoclaw`). It differs from upstream OneCLI in three
ways: it is built from source, the gateway can deny every request by default
(not only credentialed ones), and requests can be decided by Cedar policies
edited in the dashboard. This file lists every change, in this repo and in the
deployment around it.

## Branches

| Branch | Base | Status |
|---|---|---|
| `local-2.14.0` | upstream `main` at `9319d08` (release 2.14.0) | **running** |
| `local-1.41.0` | upstream 1.41.0 (`fe0981f`) | previous deployment, kept for rollback |

Nothing here is pushed upstream.

## Code changes (`local-2.14.0`)

### 1. Strict deny-by-default (`GATEWAY_STRICT_DENY`)

Upstream deny-by-default only blocks requests the gateway injects a stored
credential into, to non-LLM hosts (`has_injections && !is_llm_host`). Plain
web traffic and LLM hosts pass unless a rule blocks them, so an allow list
cannot bound an agent's egress.

With `GATEWAY_STRICT_DENY=true` on the gateway, a Default Rule Block covers
every request.

- `apps/gateway/crates/policy/src/lib.rs`: `strict_deny()` reads the variable once.
- `apps/gateway/crates/policy-engine/src/types.rs`: `enforce_deny()` returns true under strict deny.

Requests without an agent token are already refused at CONNECT in 2.14 (the
1.41 port of this patch had to add that too).

### 2. Cedar policy engine (`GATEWAY_POLICY_ENGINE=cedar`)

With the variable set, each proxied request is decided by the workspace's
Cedar policy document instead of the `policy_rules_v2` first-match engine.
Credential injection still follows the published grants. Full reference:
[`docs/cedar-policies.md`](docs/cedar-policies.md).

- `apps/gateway/Cargo.toml`: `cedar-policy = "=4.13.0"` (released 2026-09-15), pinned exactly; `Cargo.lock` updated.
- `apps/gateway/crates/policy-engine/src/cedar.rs` (new): request model (principal `OneCLI::Agent`, action per HTTP method with `read`/`write` groups, resource `OneCLI::Host`, context with path, query, headers, body, and JSON body), policy loading with a 5 s cache, decision mapping (`@approval`, `@rate_limit`, `@id`), fail-closed handling (no document, unparsable document, erroring `forbid`), and unit tests.
- `apps/gateway/crates/policy-engine/src/enforce.rs`: `evaluate()` takes the request headers and hands off to Cedar when enabled; `would_allow()` does the same from cached policies.
- `apps/gateway/crates/policy-engine/src/lib.rs`, `Cargo.toml`: module and dependencies.
- `apps/gateway/crates/proxy/src/{forward,websocket,tunnel}.rs`: pass headers to `evaluate()`; `forward.rs` buffers bodies when a Cedar document reads them.
- `apps/gateway/crates/server/src/lib.rs`: `POST /v1/cedar/validate` (parse with the gateway's parser) and `GET /v1/cedar/status` (engine and strict-deny state), both user-authenticated; cache invalidation also drops cached Cedar policies.
- `apps/gateway/crates/onecli-gateway/src/main.rs`: gives the Cedar loader the database pool and logs the engine.
- `apps/gateway/crates/{server,onecli-gateway}/Cargo.toml`: depend on `policy-engine`.

### 3. Policy storage, API, and dashboard page

- `packages/db/prisma/schema.prisma`: model `CedarPolicy` (`cedar_policies`, one document per workspace, cascades with the workspace).
- `packages/db/prisma/migrations/20261015200000_cedar_policies/`: creates the table.
- `packages/api/src/routes/cedar-policy.ts` (new), mounted in `packages/api/src/app.ts` at `/v1/cedar-policy`: `GET` (document, parsed entries, gateway status, published rules), `POST /validate`, `PUT` (validates through the gateway, saves, flushes the gateway cache; workspace managers only).
- `apps/web/src/app/(dashboard)/w/[workspaceId]/settings/policy/` (new): **Workspace Settings → Policy** page showing the default posture, the Cedar policy entries with an editor (Validate / Save), and the published rules read-only.
- `apps/web/src/lib/api/cedar-policy.ts` (new) and `lib/api/index.ts`: API client.
- `apps/web/src/lib/nav-config.ts` (+ test): "Policy" in the workspace settings menu.

## Deployment (`~/.onecli`)

| File | What changed |
|---|---|
| `docker-compose.yml` | Replaced with a 2.14 stack built from this checkout (also kept as `docker-compose.v2.yml`): `migrations`, `api`, `web`, `gateway` only, images `ghcr.io/onecli/onecli-*:2.14.0-local` with `pull_policy: never`. The gateway sets `GATEWAY_STRICT_DENY: "true"`, runs as uid `1000:1000` (owner of the existing CA files), and joins NanoClaw's `nanoclaw-egress` network with the alias `host.docker.internal`, so recreating it never drops that link. |
| `docker-compose.yml.bak-local-1.41.0`, `.bak-ghcr-1.41.0` | Previous single-container setups. |
| `.env` (mode 600, never commit) | `SECRET_ENCRYPTION_KEY` (carried over from 1.41's `/app/data/secret-encryption-key`, so stored secrets stay readable), `GATEWAY_INTERNAL_SECRET`, `BETTER_AUTH_SECRET`, `ONECLI_VERSION=2.14.0-local`, `POSTGRES_PORT=15432` (a host Postgres holds 5432), `ONECLI_EXTERNAL_URL=http://127.0.0.1:10254` (makes sign-in cookies work at that address). |
| `config.json` | CLI `api-host` → `http://127.0.0.1:10256` (backup `config.json.bak-1.41`). |
| `backups/` | `pg_dump -Fc` of the 1.41 database before the upgrade. |

Ports: dashboard 10254, gateway 10255, API 10256, Postgres 15432. The
`app-data` volume (CA key and certificate) is reused, so the gateway's CA
fingerprint is unchanged (`5F:04:25:75:3F:4E:...`).

Build images (from the repo root):

```bash
ONECLI_VERSION=2.14.0-local BETTER_AUTH_SECRET=x SECRET_ENCRYPTION_KEY=x GATEWAY_INTERNAL_SECRET=x \
  docker compose -p onecli-build -f docker/docker-compose.yml -f docker/docker-compose.build.yml build migrations api web gateway
```

Deploy: `docker compose -p onecli up -d --wait` in `~/.onecli`.

## Data changes made during the 1.41 → 2.14 upgrade

The upgrade's migrations dropped the 1.41 `policy_rules` table and created no
2.14 rules, which left the gateway allowing everything. Recreated in
`policy_rules_v2` (workspace "Default", published and as drafts so dashboard
publishes keep them):

- `Allow Anthropic API` — network target `api.anthropic.com`
- `Allow Wikipedia` — network target `*.wikipedia.org`
- `Default: block` — the deny-by-default rule (1.41 policy mode "deny")

Done in the dashboard by the operator: account registration (which adopted
the 1.41 install), and the grant "Grant: Nano · Anthropic" that gives the
NanoClaw agent its model credential.

## NanoClaw side

`~/Documents/Research/nanoclaw/.env` (backup `.env.bak-onecli-1.41`):

- `ONECLI_URL=http://127.0.0.1:10256` (2.14 serves `/v1` on the API port)
- `ONECLI_GATEWAY_CONTAINER=onecli-gateway` (egress lockdown attaches this container)
- `ONECLI_API_KEY` — the workspace API key (set by the operator)

After changing an agent's grants, restart its container so it fetches the new
credential settings: `ncl groups restart --id <agent-group-id>`.

## Rollback to 1.41

```bash
cd ~/.onecli
docker compose -p onecli down
cp docker-compose.yml.bak-local-1.41.0 docker-compose.yml
# restore the 1.41 database (2.14 migrations are not reversible)
docker compose -p onecli up -d postgres
docker exec onecli-postgres-1 dropdb -U onecli onecli
docker exec onecli-postgres-1 createdb -U onecli onecli
docker exec -i onecli-postgres-1 pg_restore -U onecli -d onecli < backups/onecli-1.41.0-preswitch-*.dump
docker compose -p onecli up -d
```

Then restore NanoClaw's `.env` from `.env.bak-onecli-1.41` and the CLI config
from `config.json.bak-1.41`. The 1.41 compose file publishes Postgres on 5432;
set `POSTGRES_PORT` if the host Postgres is running.

## Known limits

- Cedar decides allow/deny only. Which credentials an agent receives still comes from the 2.14 grants.
- Cedar's `like` has wildcards but no regular expressions; JSON floats are compared as strings.
- Bodies are inspected only up to the gateway's buffer (256 KB by default); `context.body_truncated` reports a cut.
- In 2.14 OSS the dashboard's full rule editor (Global Policy) is an Enterprise feature; the Policy page above is the local replacement for viewing and editing policy.
