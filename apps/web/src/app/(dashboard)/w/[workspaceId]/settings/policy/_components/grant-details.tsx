"use client";

import { Badge } from "@onecli/ui/components/badge";
import type {
  AgentRef,
  PublishedRule,
  SecretConfig,
} from "@/lib/api/cedar-policy";

/**
 * Local addition: each credential grant as stored — who it is for, which
 * secrets it covers, and each secret's configuration fields exactly as saved.
 * Values are never returned by the API.
 */

const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="flex gap-3 py-1">
    <span className="text-muted-foreground w-32 shrink-0 font-mono text-xs leading-5">{label}</span>
    <div className="min-w-0 flex-1">{children}</div>
  </div>
);

const Value = ({ value }: { value: unknown }) => {
  if (value === null || value === undefined || value === "") {
    return <span className="text-muted-foreground text-xs">—</span>;
  }
  if (typeof value === "object") {
    return (
      <pre className="bg-muted overflow-x-auto rounded-md p-2 font-mono text-xs">
        {JSON.stringify(value, null, 2)}
      </pre>
    );
  }
  return <code className="text-xs">{String(value)}</code>;
};

const SecretCard = ({ secret }: { secret: SecretConfig }) => (
  <div className="rounded-md border p-3 text-sm">
    <div className="mb-2 flex items-center gap-2">
      <span className="font-medium">{secret.name}</span>
      <Badge variant="outline">{secret.type}</Badge>
    </div>
    <Field label="hostPattern">
      <Value value={secret.hostPattern} />
    </Field>
    <Field label="pathPattern">
      <Value value={secret.pathPattern} />
    </Field>
    <Field label="authMode">
      <Value value={secret.authMode} />
    </Field>
    <Field label="injectionConfig">
      <Value value={secret.injectionConfig} />
    </Field>
    <Field label="scope">
      <Value value={secret.scope} />
    </Field>
    <Field label="valueSource">
      <Value value={secret.valueSource} />
    </Field>
  </div>
);

const recipients = (rule: PublishedRule, agents: AgentRef[]): string[] =>
  rule.identities.map((i) => {
    if (i.agentId) {
      const a = agents.find((x) => x.id === i.agentId);
      return a ? `agent ${a.name} (${a.identifier})` : `agent ${i.agentId}`;
    }
    if (i.userId) return `user ${i.userId}`;
    if (i.groupId) return `group ${i.groupId}`;
    return "?";
  });

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
        <div className="text-sm font-medium">{g.name}</div>
        <Field label="identities">
          {g.identities.length === 0 ? (
            <Value value={null} />
          ) : (
            <ul className="space-y-0.5 text-xs">
              {recipients(g, agents).map((r) => (
                <li key={r}>
                  <code>{r}</code>
                </li>
              ))}
            </ul>
          )}
        </Field>
        {g.targets.map((t, ti) => {
          if (t.kind !== "secret") {
            return (
              <Field key={ti} label="target">
                <Value value={t} />
              </Field>
            );
          }
          const covered = t.secretId
            ? secrets.filter((s) => s.id === t.secretId)
            : secrets.filter((s) => s.scope === t.secretScope);
          return (
            <div key={ti} className="flex flex-col gap-2">
              <Field label="target">
                <Value value={t.secretId ? { kind: "secret", secretId: t.secretId } : { kind: "secret", secretScope: t.secretScope }} />
              </Field>
              {covered.length === 0 ? (
                <p className="text-muted-foreground text-sm">No matching secret.</p>
              ) : (
                covered.map((s) => <SecretCard key={s.id} secret={s} />)
              )}
            </div>
          );
        })}
      </div>
    ))}
  </div>
);
