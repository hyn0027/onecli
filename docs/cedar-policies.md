# Cedar policies (local addition)

This checkout (branch `local-2.14.0`) makes [Cedar](https://www.cedarpolicy.com)
the gateway's only decision engine: every proxied request is allowed or blocked
by the workspace's Cedar policies. OneCLI's own `policy_rules_v2` rules are
used only for credential injection: which secrets and app connections an agent
is granted (Agents → agent → Secrets / Apps). A grant never allows a request by
itself; a Cedar policy must still permit it.

Manage policies in the dashboard under **Workspace Settings → Policy**. Each
policy is one Cedar statement with a unique name, an optional description, and
an on/off switch; the page shows each policy's code, lets you add, edit,
switch, and delete policies, and also shows the default posture and the
credential grants.

## Decision

Cedar is deny-by-default. A request passes when at least one enabled `permit`
policy matches and no enabled `forbid` policy does.

- No enabled policy in the workspace: every request is denied, including the
  model API, so agents cannot run.
- An enabled policy that fails to parse: every request is denied. Saving one is
  refused, so this only happens if the table is edited directly.
- A `forbid` policy that errors while evaluating (for example it reads
  `context.json.to` without `context has json && context.json has to`) is
  treated as matched: the request is blocked. An erroring `permit` simply does
  not apply.
- Policies are re-read from the database at most every 5 seconds per
  workspace; changes from the dashboard flush the cache immediately.

## Request model

| Part | Value |
|---|---|
| principal | `OneCLI::Agent::"<agent id>"`, attributes `id`, `identifier` (the NanoClaw agent group id), `name`; member of `OneCLI::Workspace::"<workspace id>"` |
| action | `OneCLI::Action::"<METHOD>"` — exactly the HTTP method (`GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS`, ...; an undecrypted tunnel is `CONNECT`). There are no groups: list several with `action in [OneCLI::Action::"GET", OneCLI::Action::"HEAD"]` |
| resource | `OneCLI::Host::"<host>"` (lower case, no port), attribute `name` |
| `context.method`, `host`, `port`, `path` | request line; `path` excludes the query |
| `context.query_string`, `context.query` | raw query and a record of parameters (`context.query has q && context.query.q like "..."`) |
| `context.headers` | record of the agent's request headers before injection, lower-case names (`context.headers["content-type"]`); `proxy-authorization` is omitted |
| `context.has_body`, `context.body`, `context.body_truncated` | the body as text when it was buffered (bodies are buffered only when an enabled policy mentions `body` or `json`; the first 256 KB are inspected) |
| `context.json` | the body parsed as JSON when it is a complete JSON object: objects become records, arrays sets, integers longs; floats become strings, nulls are dropped |
| `context.has_credential`, `context.is_llm_host` | whether the gateway injects a stored credential for this host, and whether the host is a known LLM provider |

## Annotations

On `permit` policies:

- `@approval` — hold matching requests for manual approval (NanoClaw routes
  the approval to an admin). When several permits match, one without
  `@approval` wins.
- `@rate_limit("60/minute")` — `hour` and `day` also work; counts per agent.

The policy's name (set in the dashboard) is its Cedar id and appears in logs
and 403 responses.

## Examples

Each block below is one policy (one dashboard entry).

```cedar
// allow-anthropic-api — the model API; agents cannot run without it.
permit(principal, action, resource == OneCLI::Host::"api.anthropic.com");
```

```cedar
// read-wikipedia — read Wikipedia, any language.
permit(
  principal,
  action in [OneCLI::Action::"GET", OneCLI::Action::"HEAD", OneCLI::Action::"OPTIONS"],
  resource
) when { resource.name like "*.wikipedia.org" };
```

```cedar
// github-issues — open issues, one NanoClaw agent group only, rate-limited.
@rate_limit("30/hour")
permit(principal, action == OneCLI::Action::"POST", resource == OneCLI::Host::"api.github.com")
when { principal.identifier == "ag-1790950856245-oo26f1" && context.path like "/repos/*/issues" };
```

```cedar
// no-external-mail — never send mail to outside addresses, whatever else allows it.
forbid(principal, action == OneCLI::Action::"POST", resource == OneCLI::Host::"gmail.googleapis.com")
when { context.has_body && !(context.body like "*@example.org*") };
```

`like` supports `*` wildcards only; Cedar has no regular expressions.

## Code

- Gateway: `apps/gateway/crates/policy-engine/src/cedar.rs` (decision, request
  model, loader), hooked into `policy_engine::evaluate` / `would_allow` (always
  on); `server` serves `/v1/cedar/validate` (checks one statement) and
  `/v1/cedar/status`.
- Storage: `cedar_policy_rules` (Prisma model `CedarPolicyRule`; name unique per
  workspace), migration `20261016000000_cedar_policy_rules`, which replaced the
  earlier single-document `cedar_policies` table.
- API: `packages/api/src/routes/cedar-policy.ts` (`/v1/cedar-policy`,
  `/v1/cedar-policy/policies[/:id]`, `/v1/cedar-policy/validate`).
- Dashboard: `apps/web/src/app/(dashboard)/w/[workspaceId]/settings/policy/`.
