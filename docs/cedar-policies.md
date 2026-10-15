# Cedar policies (local addition)

This checkout (branch `local-2.14.0`) adds an optional [Cedar](https://www.cedarpolicy.com)
policy mode to the gateway. With `GATEWAY_POLICY_ENGINE=cedar` on the gateway,
every proxied request is decided by the workspace's Cedar policy document
instead of the published `policy_rules_v2` rules. Credential injection is
unchanged: which secrets an agent gets still comes from its grants (Agents →
agent → Secrets).

Edit the document in the dashboard under **Workspace Settings → Policy**. The
page also shows the gateway's default posture and the published rules.

## Decision

Cedar is deny-by-default. A request passes when at least one `permit` policy
matches and no `forbid` policy does.

- No document saved for the workspace: every request is denied.
- A document that fails to parse: every request is denied (saving one is
  refused, so this only happens if the table is edited directly).
- A `forbid` policy that errors while evaluating (for example it reads
  `context.json.to` without `context has json && context.json has to`) is
  treated as matched: the request is blocked. An erroring `permit` simply does
  not apply.
- Requests are re-read from the database at most every 5 seconds per
  workspace; saving from the dashboard flushes the cache immediately.

## Request model

| Part | Value |
|---|---|
| principal | `OneCLI::Agent::"<agent id>"`, attributes `id`, `identifier` (the NanoClaw agent group id), `name`; member of `OneCLI::Workspace::"<workspace id>"` |
| action | `OneCLI::Action::"<METHOD>"` (`GET`, `POST`, ...; tunnels are `CONNECT`). GET/HEAD/OPTIONS are in `OneCLI::Action::"read"`, POST/PUT/PATCH/DELETE in `OneCLI::Action::"write"` |
| resource | `OneCLI::Host::"<host>"` (lower case, no port), attribute `name` |
| `context.method`, `host`, `port`, `path` | request line; `path` excludes the query |
| `context.query_string`, `context.query` | raw query and a record of parameters (`context.query has q && context.query.q like "..."`) |
| `context.headers` | record of the agent's request headers before injection, lower-case names (`context.headers["content-type"]`); `proxy-authorization` is omitted |
| `context.has_body`, `context.body`, `context.body_truncated` | the body as text when it was buffered (bodies are buffered only when the document mentions `body` or `json`; the first 256 KB are inspected) |
| `context.json` | the body parsed as JSON when it is a complete JSON object: objects become records, arrays sets, integers longs; floats become strings, nulls are dropped |
| `context.has_credential`, `context.is_llm_host` | whether the gateway injects a stored credential for this host, and whether the host is a known LLM provider |

## Annotations

On `permit` policies:

- `@approval` — hold matching requests for manual approval (NanoClaw routes
  the approval to an admin). When several permits match, one without
  `@approval` wins.
- `@rate_limit("60/minute")` — `hour` and `day` also work; counts per agent.
- `@id("name")` — names the policy in the dashboard, logs, and 403 responses.

## Examples

```cedar
// The model API (agents cannot run without it).
@id("allow-anthropic-api")
permit(principal, action, resource == OneCLI::Host::"api.anthropic.com");

// Read Wikipedia, any language.
@id("read-wikipedia")
permit(principal, action in OneCLI::Action::"read", resource)
when { resource.name like "*.wikipedia.org" };

// GitHub issues for one NanoClaw agent group only, rate-limited.
@id("github-issues")
@rate_limit("30/hour")
permit(principal, action == OneCLI::Action::"POST", resource == OneCLI::Host::"api.github.com")
when { principal.identifier == "ag-1790950856245-oo26f1" && context.path like "/repos/*/issues" };

// Never send mail to outside addresses, whatever else allows it.
@id("no-external-mail")
forbid(principal, action == OneCLI::Action::"POST", resource == OneCLI::Host::"gmail.googleapis.com")
when { context.has_body && !(context.body like "*@example.org*") };
```

`like` supports `*` wildcards only; Cedar has no regular expressions.

## Turning it on

Add `GATEWAY_POLICY_ENGINE: "cedar"` to the gateway's environment in
`~/.onecli/docker-compose.yml` and recreate it (`docker compose -p onecli up -d gateway`).
Save a document first: with Cedar on and no document, every request is denied.

## Code

- Gateway: `apps/gateway/crates/policy-engine/src/cedar.rs` (decision, request
  model, loader), hooked into `policy_engine::evaluate` / `would_allow`;
  `server` serves `/v1/cedar/validate` and `/v1/cedar/status`.
- Storage: `cedar_policies` (Prisma model `CedarPolicy`), migration
  `20261015200000_cedar_policies`.
- API: `packages/api/src/routes/cedar-policy.ts` (`/v1/cedar-policy`).
- Dashboard: `apps/web/src/app/(dashboard)/w/[workspaceId]/settings/policy/`.
