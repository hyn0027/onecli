"use client";

import { Badge } from "@onecli/ui/components/badge";
import type {
  AgentRef,
  PublishedRule,
  SecretConfig,
} from "@/lib/api/cedar-policy";

/**
 * Local addition: what each credential grant actually configures — which
 * agents receive it, which secrets it covers, and exactly where and how the
 * gateway injects each one. Mirrors the gateway's `inject::secret_inject`
 * (`build_injections`, `secret_host_patterns`) and host/path matchers; values
 * are never shown.
 */

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** Every host pattern the gateway injects this secret on. */
const effectiveHosts = (s: SecretConfig): string[] => {
  const hosts = [s.hostPattern];
  if (s.type === "openai" && s.authMode === "oauth") {
    for (const extra of ["api.openai.com", "chatgpt.com", "*.chatgpt.com", "*.openai.com"]) {
      if (!hosts.includes(extra)) hosts.push(extra);
    }
  }
  return hosts;
};

/** Patterns with 2+ wildcards ending in a wildcard label never get credentials. */
const injectable = (pattern: string) =>
  (pattern.match(/\*/g)?.length ?? 0) < 2 || pattern.split(".").pop() !== "*";

const hostRule = (pattern: string): string => {
  if (!pattern.includes("*")) return `exactly ${pattern} (any port, case-insensitive)`;
  if (pattern.startsWith("*.")) {
    return `any subdomain of ${pattern.slice(2)} — not ${pattern.slice(2)} itself`;
  }
  return `hosts matching ${pattern} (* stands for any characters)`;
};

const pathRule = (pattern: string | null): string => {
  if (!pattern || pattern === "*") return "any path";
  if (pattern.endsWith("/*") && !pattern.slice(0, -1).includes("*")) {
    return `${pattern.slice(0, -2)} and everything under it`;
  }
  if (pattern.slice(0, -1).includes("*")) {
    return `${pattern} (each * matches one path segment; a trailing * matches the rest)`;
  }
  if (pattern.endsWith("*")) return `paths starting with ${pattern.slice(0, -1)}`;
  return `exactly ${pattern}`;
};

/** How the gateway rewrites a matching request, per `build_injections`. */
const injectionRule = (s: SecretConfig): string[] => {
  const cfg = s.injectionConfig ?? {};
  switch (s.type) {
    case "anthropic":
      return s.authMode === "oauth"
        ? [
            "OAuth token: replaces the request's Authorization header with \"Bearer <token>\"",
            "only when the client sends an Authorization header (the container's CLAUDE_CODE_OAUTH_TOKEN placeholder makes Claude Code send one)",
          ]
        : [
            "API key: sets x-api-key: <key> and removes any Authorization header",
            "the gateway decides by the stored value: a token starting sk-ant-oat is always injected as OAuth",
          ];
    case "openai":
      return s.authMode === "oauth"
        ? ["ChatGPT OAuth: sets Authorization: Bearer <access token> and chatgpt-account-id; the token is refreshed by the gateway"]
        : ["API key: sets Authorization: Bearer <key>"];
    case "generic": {
      const header = str(cfg.headerName);
      if (header) return [`sets header ${header}: ${str(cfg.valueFormat) ?? "{value}"}`];
      const param = str(cfg.paramName);
      if (param) return [`sets query parameter ${param}=${str(cfg.paramFormat) ?? "{value}"}`];
      const template = str(cfg.pathTemplate);
      if (template) return [`puts the value into the path: ${template}`];
      const regex = str(cfg.pathRegex);
      if (regex) return [`rewrites the path matching ${regex} to ${str(cfg.pathReplacement) ?? ""}`];
      return ["no injection configured — this secret is never injected"];
    }
    default:
      return [`unknown type "${s.type}" — never injected`];
  }
};

const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="flex gap-3 py-1">
    <span className="text-muted-foreground w-32 shrink-0">{label}</span>
    <div className="min-w-0 flex-1">{children}</div>
  </div>
);

const SecretCard = ({ secret }: { secret: SecretConfig }) => (
  <div className="rounded-md border p-3 text-sm">
    <div className="mb-2 flex items-center gap-2">
      <span className="font-medium">{secret.name}</span>
      <Badge variant="outline">{secret.type}</Badge>
      {secret.authMode && <Badge variant="secondary">{secret.authMode}</Badge>}
    </div>
    <Field label="Injected on">
      <ul className="space-y-0.5">
        {effectiveHosts(secret).map((h) => (
          <li key={h}>
            <code className="text-xs">{h}</code>
            <span className="text-muted-foreground"> — {hostRule(h)}</span>
            {h !== secret.hostPattern && (
              <span className="text-muted-foreground"> (added for OpenAI OAuth)</span>
            )}
            {!injectable(h) && (
              <span className="text-destructive"> — never injected: pattern ends in a wildcard</span>
            )}
          </li>
        ))}
      </ul>
    </Field>
    <Field label="Path">
      <code className="text-xs">{secret.pathPattern ?? "*"}</code>
      <span className="text-muted-foreground"> — {pathRule(secret.pathPattern)}; the query string is ignored</span>
    </Field>
    <Field label="Injection">
      <ul className="list-disc space-y-0.5 pl-4">
        {injectionRule(secret).map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </Field>
    <Field label="Stored">
      {secret.scope} secret,{" "}
      {secret.valueSource === "onepassword"
        ? "value fetched from 1Password per request"
        : "value encrypted in OneCLI's database"}
    </Field>
  </div>
);

const recipients = (rule: PublishedRule, agents: AgentRef[]): string => {
  if (rule.identities.length === 0) return "nobody (a grant needs an explicit agent, user, or group)";
  return rule.identities
    .map((i) => {
      if (i.agentId) {
        const a = agents.find((x) => x.id === i.agentId);
        return a ? `${a.name} (${a.identifier})` : `agent ${i.agentId}`;
      }
      if (i.userId) return "a user's agents";
      if (i.groupId) return "a group's agents";
      return "?";
    })
    .join(", ");
};

export const GrantDetails = ({
  grants,
  secrets,
  agents,
}: {
  grants: PublishedRule[];
  secrets: SecretConfig[];
  agents: AgentRef[];
}) => (
  <div className="flex flex-col gap-4">
    {grants.map((g, gi) => (
      <div key={`${g.name}-${gi}`} className="flex flex-col gap-2">
        <div className="text-sm">
          <span className="font-medium">{g.name}</span>
          <span className="text-muted-foreground"> — for {recipients(g, agents)}</span>
        </div>
        {g.targets.map((t, ti) => {
          if (t.kind === "secret") {
            const covered = t.secretId
              ? secrets.filter((s) => s.id === t.secretId)
              : secrets.filter((s) => s.scope === t.secretScope);
            if (covered.length === 0) {
              return (
                <p key={ti} className="text-muted-foreground text-sm">
                  {t.secretId ? "The granted secret no longer exists." : `No ${t.secretScope} secrets stored.`}
                </p>
              );
            }
            return (
              <div key={ti} className="flex flex-col gap-2">
                {!t.secretId && (
                  <p className="text-muted-foreground text-sm">
                    Grants every {t.secretScope} secret, including ones added later:
                  </p>
                )}
                {covered.map((s) => (
                  <SecretCard key={s.id} secret={s} />
                ))}
              </div>
            );
          }
          if (t.kind === "app") {
            return (
              <p key={ti} className="text-sm">
                App <code className="text-xs">{t.appProvider}</code>: OAuth connections of this provider, injected on the provider's own API hosts.
              </p>
            );
          }
          return (
            <p key={ti} className="text-sm">
              {t.kind} target
            </p>
          );
        })}
      </div>
    ))}
  </div>
);
