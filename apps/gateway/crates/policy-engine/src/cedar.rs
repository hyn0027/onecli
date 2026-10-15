//! Cedar policy mode (`GATEWAY_POLICY_ENGINE=cedar`): every proxied request is
//! decided by the workspace's Cedar policy set instead of the `policy_rules_v2`
//! first-match engine. Local addition on top of OneCLI 2.14.
//!
//! Cedar is default-deny: a request passes only when a `permit` policy is
//! satisfied and no `forbid` policy is. Policies are stored as one Cedar
//! document per workspace in `cedar_policies` and reloaded at most every
//! [`RELOAD_AFTER`]; a workspace with no document denies everything, and a
//! document that fails to parse denies everything (fail closed).
//!
//! Request model (see `docs/cedar-policies.md`):
//! - principal `OneCLI::Agent::"<agent id>"` (attrs `id`, `identifier`, `name`),
//!   member of `OneCLI::Workspace::"<workspace id>"`;
//! - action `OneCLI::Action::"<METHOD>"`; GET/HEAD/OPTIONS are in
//!   `Action::"read"`, POST/PUT/PATCH/DELETE in `Action::"write"`;
//! - resource `OneCLI::Host::"<host>"` (attr `name`);
//! - context: `method`, `host`, `port`, `path`, `query_string`, `query`
//!   (record of parameters), `headers` (record, lower-case names), `has_body`,
//!   `body` (string, when buffered), `body_truncated`, `json` (the body parsed
//!   as JSON, when it is a JSON object), `has_credential`, `is_llm_host`.
//!
//! Annotations on `permit` policies: `@approval` holds matching requests for
//! manual approval (a satisfied permit without it wins), `@rate_limit("N/minute")`
//! (or hour/day) rate-limits them. `@id("name")` names a policy in logs and 403s.
//!
//! A `forbid` policy that errors while evaluating (for example it reads an
//! attribute the request lacks, without a `has` guard) blocks the request: an
//! erroring restriction is treated as matched, never silently skipped.

use std::collections::{HashMap, HashSet};
use std::str::FromStr;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use cedar_policy::{
    Authorizer, Context, Decision, Effect, Entities, Entity, EntityId, EntityTypeName, EntityUid,
    Policy, PolicyId, PolicySet, Request, RestrictedExpression,
};
use dashmap::DashMap;
use serde_json::{Map, Value};
use sqlx::PgPool;
use tracing::{debug, warn};

use cache::CacheStore;
use common::util::strip_port;
use context::ProxyContext;
use policy::{check_rate_limit, ConditionBody, MatchedRule, PolicyDecision};

const ENGINE_ENV: &str = "GATEWAY_POLICY_ENGINE";
/// How long a loaded policy document is reused before re-reading the database.
const RELOAD_AFTER: Duration = Duration::from_secs(5);
/// JSON nesting kept when converting a body to a Cedar value; deeper parts become strings.
const MAX_JSON_DEPTH: usize = 32;

const READ_METHODS: [&str; 3] = ["GET", "HEAD", "OPTIONS"];
const WRITE_METHODS: [&str; 4] = ["POST", "PUT", "PATCH", "DELETE"];

/// Whether the gateway decides requests with Cedar.
pub fn enabled() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| {
        std::env::var(ENGINE_ENV)
            .map(|v| v.trim().eq_ignore_ascii_case("cedar"))
            .unwrap_or(false)
    })
}

/// Whether the gateway runs with `GATEWAY_STRICT_DENY` (re-exported for the server).
pub fn strict_deny() -> bool {
    policy::strict_deny()
}

static POOL: OnceLock<PgPool> = OnceLock::new();

/// Give the Cedar loader the gateway's database pool (called once at startup).
pub fn init(pool: PgPool) {
    let _ = POOL.set(pool);
}

/// One workspace's policy document as the gateway last loaded it.
pub struct LoadedPolicies {
    /// The parsed set, or why the document could not be used (then every request is denied).
    pub set: Result<PolicySet, String>,
    /// Whether any policy mentions the body, so requests must be buffered for it.
    pub inspects_body: bool,
}

fn cache() -> &'static DashMap<String, (Instant, Arc<LoadedPolicies>)> {
    static CACHE: OnceLock<DashMap<String, (Instant, Arc<LoadedPolicies>)>> = OnceLock::new();
    CACHE.get_or_init(DashMap::new)
}

/// Parse a policy document and check the annotations this gateway interprets.
pub fn parse(text: &str) -> Result<PolicySet, String> {
    let set = PolicySet::from_str(text).map_err(|e| format!("{e:?}"))?;
    for policy in set.policies() {
        let name = display_name(policy);
        if let Some(spec) = policy.annotation("rate_limit") {
            if policy.effect() != Effect::Permit {
                return Err(format!("{name}: @rate_limit only applies to permit policies"));
            }
            parse_rate_limit(spec).ok_or_else(|| {
                format!("{name}: @rate_limit(\"{spec}\") must look like \"60/minute\" (minute, hour, or day)")
            })?;
        }
        if policy.annotation("approval").is_some() && policy.effect() != Effect::Permit {
            return Err(format!("{name}: @approval only applies to permit policies"));
        }
    }
    Ok(set)
}

/// One policy as the dashboard lists it.
#[derive(serde::Serialize)]
pub struct PolicySummary {
    pub id: String,
    pub name: String,
    pub effect: &'static str,
    pub approval: bool,
    pub rate_limit: Option<String>,
}

/// Parse a document and describe each policy, or the parse error.
pub fn summarize(text: &str) -> Result<Vec<PolicySummary>, String> {
    let set = parse(text)?;
    let mut out: Vec<PolicySummary> = set
        .policies()
        .map(|p| PolicySummary {
            id: p.id().to_string(),
            name: display_name(p),
            effect: if p.effect() == Effect::Permit { "permit" } else { "forbid" },
            approval: p.annotation("approval").is_some(),
            rate_limit: p.annotation("rate_limit").map(str::to_string),
        })
        .collect();
    out.sort_by_key(|s| s.id.trim_start_matches("policy").parse::<u64>().unwrap_or(u64::MAX));
    Ok(out)
}

/// Forget a workspace's cached policies so the next request reloads them.
pub fn invalidate(workspace_id: &str) {
    cache().remove(workspace_id);
}

/// Whether the document can read the request body (conservative text check).
fn mentions_body(text: &str) -> bool {
    text.contains("body") || text.contains("json")
}

/// The workspace's policies, reloaded from the database at most every [`RELOAD_AFTER`].
pub async fn policies_for(workspace_id: &str) -> Arc<LoadedPolicies> {
    if let Some(entry) = cache().get(workspace_id) {
        if entry.0.elapsed() < RELOAD_AFTER {
            return Arc::clone(&entry.1);
        }
    }
    let loaded = match load(workspace_id).await {
        Ok(text) => Arc::new(LoadedPolicies {
            inspects_body: text.as_deref().is_some_and(mentions_body),
            // No document: an empty set, which denies every request.
            set: text.map_or_else(|| Ok(PolicySet::new()), |t| parse(&t)),
        }),
        Err(e) => {
            // Keep serving the last good policies through a transient DB error.
            if let Some(entry) = cache().get(workspace_id) {
                warn!(workspace = workspace_id, error = %e, "cedar: reload failed, keeping previous policies");
                return Arc::clone(&entry.1);
            }
            Arc::new(LoadedPolicies {
                set: Err(format!("policies could not be loaded: {e}")),
                inspects_body: false,
            })
        }
    };
    if let Err(e) = &loaded.set {
        warn!(workspace = workspace_id, error = %e, "cedar: policy document unusable, denying all requests");
    }
    cache().insert(workspace_id.to_string(), (Instant::now(), Arc::clone(&loaded)));
    loaded
}

async fn load(workspace_id: &str) -> anyhow::Result<Option<String>> {
    let pool = POOL
        .get()
        .ok_or_else(|| anyhow::anyhow!("cedar loader not initialised"))?;
    let text = sqlx::query_scalar::<_, String>(
        "SELECT policy_text FROM cedar_policies WHERE workspace_id = $1",
    )
    .bind(workspace_id)
    .fetch_optional(pool)
    .await?;
    Ok(text)
}

/// Whether requests to this workspace must have their bodies buffered.
pub async fn needs_body_buffer(workspace_id: Option<&str>) -> bool {
    match workspace_id {
        Some(ws) => policies_for(ws).await.inspects_body,
        None => false,
    }
}

/// One request as Cedar sees it.
pub struct CedarRequest<'a> {
    pub host: &'a str,
    pub method: &'a str,
    /// Path including the query string.
    pub path: &'a str,
    /// Request headers as sent by the agent, before credential injection.
    pub headers: &'a [(String, String)],
    pub body: ConditionBody<'a>,
    pub has_injections: bool,
    pub is_llm_host: bool,
}

/// What the policies say about one request, before rate limiting.
enum Judgement {
    Blocked { name: String, rule: Option<MatchedRule> },
    DefaultDeny,
    Approval { rule_id: String, rule: MatchedRule },
    Allow { rule: Option<MatchedRule>, rate: Option<(String, String, u64, u64)> },
}

fn judge(
    proxy_ctx: &ProxyContext,
    loaded: &LoadedPolicies,
    request: &CedarRequest<'_>,
) -> Judgement {
    let (Some(workspace_id), Some(agent_id)) = (
        proxy_ctx.workspace_id.as_deref(),
        proxy_ctx.agent_id.as_deref(),
    ) else {
        // Unlike the rule engine, an unidentified request is not waved through.
        return Judgement::Blocked { name: "Cedar: request has no agent identity".into(), rule: None };
    };
    let policies = match &loaded.set {
        Ok(set) => set,
        Err(_) => return Judgement::Blocked { name: "Cedar policy document unusable".into(), rule: None },
    };
    let (cedar_request, entities) = match build(proxy_ctx, agent_id, workspace_id, request) {
        Ok(built) => built,
        Err(e) => {
            warn!(error = %e, "cedar: could not build request, denying");
            return Judgement::Blocked { name: "Cedar: malformed request".into(), rule: None };
        }
    };
    let response = Authorizer::new().is_authorized(&cedar_request, policies, &entities);

    // An erroring forbid counts as matched (fail closed).
    for error in response.diagnostics().errors() {
        let cedar_policy::AuthorizationError::PolicyEvaluationError(eval_error) = error;
        let id = eval_error.policy_id();
        if let Some(policy) = policies.policy(id) {
            if policy.effect() == Effect::Forbid {
                let name = display_name(policy);
                warn!(policy = %name, error = %error, "cedar: forbid policy errored, treating as matched");
                return Judgement::Blocked { rule: Some(matched(id, &name)), name };
            }
        }
        debug!(error = %error, "cedar: policy evaluation error (permit not applied)");
    }

    let satisfied: Vec<(&PolicyId, &Policy)> = response
        .diagnostics()
        .reason()
        .filter_map(|id| policies.policy(id).map(|p| (id, p)))
        .collect();

    if response.decision() == Decision::Deny {
        return match satisfied.iter().find(|(_, p)| p.effect() == Effect::Forbid) {
            Some((id, p)) => {
                let name = display_name(p);
                Judgement::Blocked { rule: Some(matched(id, &name)), name }
            }
            None => Judgement::DefaultDeny,
        };
    }

    // Allowed: prefer a plain permit, then a rate-limited one, then one needing approval.
    let mut permits: Vec<&(&PolicyId, &Policy)> = satisfied
        .iter()
        .filter(|(_, p)| p.effect() == Effect::Permit)
        .collect();
    permits.sort_by_key(|(id, p)| {
        let rank = if p.annotation("approval").is_some() {
            2
        } else if p.annotation("rate_limit").is_some() {
            1
        } else {
            0
        };
        (rank, id.to_string())
    });
    let Some((id, policy)) = permits.first() else {
        return Judgement::DefaultDeny;
    };
    let name = display_name(policy);
    if policy.annotation("approval").is_some() {
        return Judgement::Approval { rule_id: format!("cedar:{id}"), rule: matched(id, &name) };
    }
    let rate = policy
        .annotation("rate_limit")
        .and_then(parse_rate_limit)
        .map(|(limit, secs)| (format!("cedar:{id}"), name.clone(), limit, secs));
    Judgement::Allow { rule: Some(matched(id, &name)), rate }
}

/// Decide a request with the workspace's current policies.
pub async fn decide(
    proxy_ctx: &ProxyContext,
    request: &CedarRequest<'_>,
    cache: &dyn CacheStore,
) -> (PolicyDecision, Option<MatchedRule>) {
    let Some(workspace_id) = proxy_ctx.workspace_id.as_deref() else {
        return (blocked("Cedar: request has no agent identity"), None);
    };
    let loaded = policies_for(workspace_id).await;
    match judge(proxy_ctx, &loaded, request) {
        Judgement::Blocked { name, rule } => (blocked(&name), rule),
        Judgement::DefaultDeny => (PolicyDecision::BlockedByDefaultPolicy, None),
        Judgement::Approval { rule_id, rule } => (PolicyDecision::ManualApproval { rule_id }, Some(rule)),
        Judgement::Allow { rule, rate: None } => (PolicyDecision::Allow, rule),
        Judgement::Allow { rule, rate: Some((rule_id, name, limit, window_secs)) } => {
            let org_id = proxy_ctx.organization_id.as_deref().unwrap_or("");
            match check_rate_limit(
                org_id,
                workspace_id,
                &rule_id,
                &name,
                limit,
                window_secs,
                proxy_ctx.agent_token.as_str(),
                cache,
            )
            .await
            {
                Some(limited) => (limited, rule),
                None => (PolicyDecision::Allow, rule),
            }
        }
    }
}

/// Whether the request would plainly pass (no approval, no rate limit), from
/// the policies already in memory; false when none are loaded yet (fail closed).
/// Side-effect free: never touches rate-limit counters or the database.
pub fn would_allow(proxy_ctx: &ProxyContext, request: &CedarRequest<'_>) -> bool {
    let Some(workspace_id) = proxy_ctx.workspace_id.as_deref() else {
        return false;
    };
    let Some(loaded) = cache().get(workspace_id).map(|e| Arc::clone(&e.1)) else {
        return false;
    };
    matches!(judge(proxy_ctx, &loaded, request), Judgement::Allow { rate: None, .. })
}

fn blocked(name: &str) -> PolicyDecision {
    PolicyDecision::Blocked {
        rule_name: name.to_string(),
    }
}

fn matched(id: &PolicyId, name: &str) -> MatchedRule {
    MatchedRule {
        logical_id: format!("cedar:{id}"),
        name: name.to_string(),
        scope: "workspace".to_string(),
    }
}

/// `@id("...")` when present, else Cedar's positional id (`policy0`, ...).
pub fn display_name(policy: &Policy) -> String {
    policy
        .annotation("id")
        .map(str::to_string)
        .unwrap_or_else(|| policy.id().to_string())
}

/// "60/minute" → (60, 60); minute, hour, or day.
fn parse_rate_limit(spec: &str) -> Option<(u64, u64)> {
    let (count, window) = spec.trim().split_once('/')?;
    let count: u64 = count.trim().parse().ok().filter(|n| *n > 0)?;
    let secs = match window.trim() {
        "minute" => 60,
        "hour" => 3600,
        "day" => 86400,
        _ => return None,
    };
    Some((count, secs))
}

fn uid(type_name: &str, id: &str) -> anyhow::Result<EntityUid> {
    Ok(EntityUid::from_type_name_and_id(
        EntityTypeName::from_str(type_name).map_err(|e| anyhow::anyhow!("{e}"))?,
        EntityId::new(id),
    ))
}

fn build(
    proxy_ctx: &ProxyContext,
    agent_id: &str,
    workspace_id: &str,
    request: &CedarRequest<'_>,
) -> anyhow::Result<(Request, Entities)> {
    let method = request.method.to_ascii_uppercase();
    let host = strip_port(request.host).to_ascii_lowercase();

    let workspace = uid("OneCLI::Workspace", workspace_id)?;
    let principal = uid("OneCLI::Agent", agent_id)?;
    let action = uid("OneCLI::Action", &method)?;
    let resource = uid("OneCLI::Host", &host)?;

    let read = uid("OneCLI::Action", "read")?;
    let write = uid("OneCLI::Action", "write")?;
    let mut action_parents = HashSet::new();
    if READ_METHODS.contains(&method.as_str()) {
        action_parents.insert(read.clone());
    } else if WRITE_METHODS.contains(&method.as_str()) {
        action_parents.insert(write.clone());
    }

    let string = |s: &str| RestrictedExpression::new_string(s.to_string());
    let agent_attrs: HashMap<String, RestrictedExpression> = [
        ("id".to_string(), string(agent_id)),
        (
            "identifier".to_string(),
            string(proxy_ctx.agent_identifier.as_deref().unwrap_or("")),
        ),
        (
            "name".to_string(),
            string(proxy_ctx.agent_name.as_deref().unwrap_or("")),
        ),
    ]
    .into();
    let host_attrs: HashMap<String, RestrictedExpression> =
        [("name".to_string(), string(&host))].into();

    let entities = Entities::from_entities(
        [
            Entity::new(principal.clone(), agent_attrs, HashSet::from([workspace.clone()]))?,
            Entity::new_no_attrs(workspace, HashSet::new()),
            Entity::new(resource.clone(), host_attrs, HashSet::new())?,
            Entity::new_no_attrs(action.clone(), action_parents),
            Entity::new_no_attrs(read, HashSet::new()),
            Entity::new_no_attrs(write, HashSet::new()),
        ],
        None,
    )?;

    let context = Context::from_json_value(context_json(request, &method, &host), None)?;
    let cedar_request = Request::new(principal, action, resource, context, None)?;
    Ok((cedar_request, entities))
}

fn context_json(request: &CedarRequest<'_>, method: &str, host: &str) -> Value {
    let (path, query_string) = request.path.split_once('?').unwrap_or((request.path, ""));
    let mut query = Map::new();
    for (key, value) in form_urlencoded::parse(query_string.as_bytes()) {
        query.insert(safe_key(&key), Value::String(value.into_owned()));
    }
    let mut headers = Map::new();
    for (name, value) in request.headers {
        let name = name.to_ascii_lowercase();
        if name == "proxy-authorization" {
            continue;
        }
        headers.insert(safe_key(&name), Value::String(value.clone()));
    }
    let port = request
        .host
        .rsplit_once(':')
        .and_then(|(_, p)| p.parse::<i64>().ok())
        .unwrap_or(443);

    let mut ctx = Map::new();
    ctx.insert("method".into(), Value::String(method.to_string()));
    ctx.insert("host".into(), Value::String(host.to_string()));
    ctx.insert("port".into(), Value::from(port));
    ctx.insert("path".into(), Value::String(path.to_string()));
    ctx.insert("query_string".into(), Value::String(query_string.to_string()));
    ctx.insert("query".into(), Value::Object(query));
    ctx.insert("headers".into(), Value::Object(headers));
    ctx.insert("has_credential".into(), Value::Bool(request.has_injections));
    ctx.insert("is_llm_host".into(), Value::Bool(request.is_llm_host));
    ctx.insert("body_truncated".into(), Value::Bool(request.body.is_truncated()));
    let bytes = request.body.bytes();
    ctx.insert(
        "has_body".into(),
        Value::Bool(bytes.is_some_and(|b| !b.is_empty())),
    );
    if let Some(bytes) = bytes {
        ctx.insert(
            "body".into(),
            Value::String(String::from_utf8_lossy(bytes).into_owned()),
        );
        if let ConditionBody::Full(full) = request.body {
            if let Ok(Value::Object(obj)) = serde_json::from_slice::<Value>(full) {
                ctx.insert("json".into(), to_cedar_json(Value::Object(obj), 0));
            }
        }
    }
    Value::Object(ctx)
}

/// Cedar's JSON context format reserves `__entity` / `__extn` / `__expr` keys.
fn safe_key(key: &str) -> String {
    if key.starts_with("__") {
        format!("_{key}")
    } else {
        key.to_string()
    }
}

/// Map arbitrary JSON onto values Cedar accepts: objects → records, arrays →
/// sets, integers → longs; floats, out-of-range numbers, and over-deep parts →
/// strings; nulls are dropped.
fn to_cedar_json(value: Value, depth: usize) -> Value {
    if depth >= MAX_JSON_DEPTH {
        return Value::String(value.to_string());
    }
    match value {
        Value::Object(obj) => Value::Object(
            obj.into_iter()
                .filter(|(_, v)| !v.is_null())
                .map(|(k, v)| (safe_key(&k), to_cedar_json(v, depth + 1)))
                .collect(),
        ),
        Value::Array(items) => Value::Array(
            items
                .into_iter()
                .filter(|v| !v.is_null())
                .map(|v| to_cedar_json(v, depth + 1))
                .collect(),
        ),
        Value::Number(n) => match n.as_i64() {
            Some(i) => Value::from(i),
            None => Value::String(n.to_string()),
        },
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx() -> ProxyContext {
        ProxyContext {
            workspace_id: Some("ws1".into()),
            organization_id: Some("org1".into()),
            agent_id: Some("agent1".into()),
            agent_name: Some("Nano".into()),
            agent_identifier: Some("ag-1".into()),
            agent_token: "tok".into(),
        }
    }

    fn eval(text: &str, method: &str, host: &str, path: &str, headers: &[(String, String)], body: Option<&[u8]>) -> Decision {
        let set = parse(text).expect("policy parses");
        let req = CedarRequest {
            host,
            method,
            path,
            headers,
            body: body.map_or(ConditionBody::None, ConditionBody::Full),
            has_injections: false,
            is_llm_host: false,
        };
        let (r, e) = build(&ctx(), "agent1", "ws1", &req).expect("request builds");
        Authorizer::new().is_authorized(&r, &set, &e).decision()
    }

    #[test]
    fn default_deny_and_host_permit() {
        let p = r#"permit(principal, action in OneCLI::Action::"read", resource == OneCLI::Host::"en.wikipedia.org");"#;
        assert_eq!(eval(p, "GET", "en.wikipedia.org:443", "/wiki/X", &[], None), Decision::Allow);
        assert_eq!(eval(p, "POST", "en.wikipedia.org", "/wiki/X", &[], None), Decision::Deny);
        assert_eq!(eval(p, "GET", "example.com", "/", &[], None), Decision::Deny);
        assert_eq!(eval("", "GET", "example.com", "/", &[], None), Decision::Deny);
    }

    #[test]
    fn wildcard_host_query_header_and_json() {
        let p = r#"
            permit(principal, action, resource) when {
              resource.name like "*.wikipedia.org" &&
              context.query has q && context.query.q like "cedar*"
            };
            forbid(principal, action == OneCLI::Action::"POST", resource) when {
              context has json && context.json has to && context.json.to like "*@evil.com"
            };
            permit(principal, action == OneCLI::Action::"POST", resource == OneCLI::Host::"api.example.com") when {
              context.headers has "content-type" && context.headers["content-type"] like "application/json*"
            };
        "#;
        assert_eq!(eval(p, "GET", "de.wikipedia.org", "/w?q=cedar+policy", &[], None), Decision::Allow);
        assert_eq!(eval(p, "GET", "de.wikipedia.org", "/w?q=other", &[], None), Decision::Deny);
        let json = [("content-type".to_string(), "application/json".to_string())];
        assert_eq!(eval(p, "POST", "api.example.com", "/send", &json, Some(br#"{"to":"a@ok.com","n":1.5}"#)), Decision::Allow);
        assert_eq!(eval(p, "POST", "api.example.com", "/send", &json, Some(br#"{"to":"x@evil.com"}"#)), Decision::Deny);
    }

    #[test]
    fn annotations_are_checked() {
        assert!(parse(r#"@rate_limit("10/minute") permit(principal, action, resource);"#).is_ok());
        assert!(parse(r#"@rate_limit("ten") permit(principal, action, resource);"#).is_err());
        assert!(parse(r#"@approval forbid(principal, action, resource);"#).is_err());
        assert_eq!(parse_rate_limit("5/hour"), Some((5, 3600)));
    }

    #[test]
    fn principal_attributes_and_workspace() {
        let p = r#"permit(principal in OneCLI::Workspace::"ws1", action, resource) when { principal.identifier == "ag-1" };"#;
        assert_eq!(eval(p, "DELETE", "x.com", "/", &[], None), Decision::Allow);
    }
}
