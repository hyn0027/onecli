"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Badge } from "@onecli/ui/components/badge";
import { Button } from "@onecli/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@onecli/ui/components/card";
import { Skeleton } from "@onecli/ui/components/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@onecli/ui/components/table";
import { Textarea } from "@onecli/ui/components/textarea";
import { cedarPolicy } from "@/lib/api";
import type {
  CedarPolicyState,
  CedarPolicySummary,
  CedarValidation,
  PublishedRule,
} from "@/lib/api/cedar-policy";

const QUERY_KEY = ["cedar-policy"] as const;

/** Offered when the workspace has no document yet: the same reach as a
 *  deny-by-default setup that allows the model API and reading Wikipedia. */
const STARTER = `// Cedar is deny-by-default: a request passes only if some permit matches
// and no forbid does. Entities: principal OneCLI::Agent (id, identifier,
// name), action OneCLI::Action::"<METHOD>" (in Action::"read" or "write"),
// resource OneCLI::Host (name). Context: method, host, port, path, query,
// query_string, headers, has_body, body, json, has_credential, is_llm_host.

// The model API — agents cannot run without it.
@id("allow-anthropic-api")
permit(principal, action, resource == OneCLI::Host::"api.anthropic.com");

// Read Wikipedia in any language.
@id("read-wikipedia")
permit(principal, action in OneCLI::Action::"read", resource)
when { resource.name like "*.wikipedia.org" };
`;

const effectBadge = (effect: string) => (
  <Badge variant={effect === "forbid" ? "destructive" : "secondary"}>
    {effect}
  </Badge>
);

const PolicyEntries = ({ policies }: { policies: CedarPolicySummary[] }) =>
  policies.length === 0 ? (
    <p className="text-muted-foreground text-sm">
      No policies — every request is denied.
    </p>
  ) : (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-12">#</TableHead>
          <TableHead>Policy</TableHead>
          <TableHead>Effect</TableHead>
          <TableHead>Modifiers</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {policies.map((p, i) => (
          <TableRow key={p.id}>
            <TableCell className="text-muted-foreground">{i + 1}</TableCell>
            <TableCell className="font-mono text-sm">{p.name}</TableCell>
            <TableCell>{effectBadge(p.effect)}</TableCell>
            <TableCell className="text-sm">
              {[
                p.approval ? "needs approval" : null,
                p.rate_limit ? `rate limit ${p.rate_limit}` : null,
              ]
                .filter(Boolean)
                .join(", ") || "—"}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );

const describeTargets = (rule: PublishedRule): string => {
  if (rule.isDefault) return "every request no rule above matched";
  return (
    rule.targets
      .map((t) => {
        if (t.kind === "network") {
          return `${t.method ? `${t.method} ` : ""}${t.hostPattern ?? ""}${t.pathPattern ?? ""}`;
        }
        if (t.kind === "secret") {
          return t.secretScope
            ? `all ${t.secretScope} secrets (grant)`
            : "a stored secret (grant)";
        }
        if (t.kind === "app") return `app: ${t.appProvider}`;
        return t.kind;
      })
      .join(", ") || "—"
  );
};

const RulesTable = ({ rules }: { rules: PublishedRule[] }) => (
  <Table>
    <TableHeader>
      <TableRow>
        <TableHead className="w-12">#</TableHead>
        <TableHead>Rule</TableHead>
        <TableHead>Action</TableHead>
        <TableHead>Matches</TableHead>
        <TableHead>Applies to</TableHead>
      </TableRow>
    </TableHeader>
    <TableBody>
      {rules.map((r, i) => (
        <TableRow key={`${r.name}-${i}`} className={r.isDefault ? "bg-muted/50" : undefined}>
          <TableCell className="text-muted-foreground">
            {r.isDefault ? "—" : i + 1}
          </TableCell>
          <TableCell className="text-sm">
            {r.name}
            {r.isDefault && (
              <Badge variant="outline" className="ml-2">
                default
              </Badge>
            )}
          </TableCell>
          <TableCell>
            <Badge variant={r.action === "block" ? "destructive" : "secondary"}>
              {r.action}
            </Badge>
            {r.requireApproval && <span className="ml-2 text-xs">+ approval</span>}
            {r.rateLimit && (
              <span className="ml-2 text-xs">
                + {r.rateLimit}/{r.rateLimitWindow}
              </span>
            )}
          </TableCell>
          <TableCell className="font-mono text-xs">{describeTargets(r)}</TableCell>
          <TableCell className="text-sm">
            {r.identities.length === 0
              ? "all agents"
              : `${r.identities.length} principal(s)`}
          </TableCell>
        </TableRow>
      ))}
    </TableBody>
  </Table>
);

/** The default posture in words, from what the gateway reports. */
const posture = (state: CedarPolicyState) => {
  const gw = state.gateway;
  if (!gw) {
    return {
      engine: "Unknown (gateway did not answer)",
      defaultLine: "Unknown",
      detail: "",
    };
  }
  if (gw.engine === "cedar") {
    return {
      engine: "Cedar policies",
      defaultLine: "Block",
      detail:
        "Cedar denies every request that no permit policy matches, credentialed or not, LLM hosts included. A document that fails to parse denies everything.",
    };
  }
  const hasDefaultBlock = state.rules.rules.some(
    (r) => r.isDefault && r.action === "block",
  );
  return {
    engine: "Rule engine (the Cedar document below is not enforced yet)",
    defaultLine: hasDefaultBlock ? "Block" : "Allow",
    detail: hasDefaultBlock
      ? gw.strictDeny
        ? "Strict deny is on: the default block covers every request, including uncredentialed ones and LLM hosts."
        : "Strict deny is off: the default block only covers requests the gateway injects a credential into, to non-LLM hosts."
      : "No default rule: anything not blocked by a rule passes.",
  };
};

export const PolicyContent = () => {
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: cedarPolicy.get,
  });

  const [text, setText] = useState("");
  const [checked, setChecked] = useState<CedarValidation | null>(null);
  useEffect(() => {
    if (data) {
      setText(data.policyText ?? STARTER);
      setChecked(data.validation);
    }
  }, [data]);

  const dirty = data ? text !== (data.policyText ?? "") : false;

  const validate = useMutation({
    mutationFn: () => cedarPolicy.validate(text),
    onSuccess: (result) => setChecked(result),
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : "Validation failed"),
  });

  const save = useMutation({
    mutationFn: () => cedarPolicy.save(text),
    onSuccess: (result) => {
      setChecked(result.validation);
      toast.success("Cedar policy saved");
      void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : "Could not save"),
  });

  const p = useMemo(() => (data ? posture(data) : null), [data]);

  if (isLoading) return <Skeleton className="h-64 w-full" />;
  if (error || !data || !p) {
    return (
      <Card className="p-6 text-sm">
        Could not load the policy:{" "}
        {error instanceof Error ? error.message : "unknown error"}
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Enforcement</CardTitle>
          <CardDescription>How the gateway decides each request.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-2 text-sm">
          <div className="flex gap-2">
            <span className="text-muted-foreground w-36 shrink-0">Decided by</span>
            <span>{p.engine}</span>
          </div>
          <div className="flex gap-2">
            <span className="text-muted-foreground w-36 shrink-0">By default</span>
            <span>
              <Badge variant={p.defaultLine === "Block" ? "destructive" : "secondary"}>
                {p.defaultLine}
              </Badge>{" "}
              {p.detail}
            </span>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Cedar policies</CardTitle>
          <CardDescription>
            {data.policyText === null
              ? "No document saved yet — the editor holds a starting point."
              : `Saved ${data.updatedAt ? new Date(data.updatedAt).toLocaleString() : ""}.`}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {checked?.valid === true && <PolicyEntries policies={checked.policies} />}
          {checked?.valid === false && (
            <pre className="border-destructive bg-destructive/5 text-destructive overflow-x-auto rounded-md border p-3 text-xs whitespace-pre-wrap">
              {checked.error}
            </pre>
          )}
          <Textarea
            value={text}
            onChange={(e) => {
              setText(e.target.value);
            }}
            spellCheck={false}
            rows={20}
            className="font-mono text-xs"
            aria-label="Cedar policy document"
          />
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              onClick={() => validate.mutate()}
              disabled={validate.isPending}
            >
              {validate.isPending ? "Checking..." : "Validate"}
            </Button>
            <Button
              onClick={() => save.mutate()}
              disabled={save.isPending || (!dirty && data.policyText !== null)}
            >
              {save.isPending ? "Saving..." : "Save"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Published rules</CardTitle>
          <CardDescription>
            The rule engine's current set (generation {data.rules.generation ?? "none"}),
            first match wins.{" "}
            {data.gateway?.engine === "cedar"
              ? "Not used for decisions while Cedar is on; secret grants still decide which credentials agents get."
              : "These decide requests now."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {data.rules.rules.length === 0 ? (
            <p className="text-muted-foreground text-sm">No published rules.</p>
          ) : (
            <RulesTable rules={data.rules.rules} />
          )}
        </CardContent>
      </Card>
    </div>
  );
};
