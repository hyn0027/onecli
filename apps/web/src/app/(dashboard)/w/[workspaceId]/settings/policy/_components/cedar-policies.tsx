"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@onecli/ui/components/alert-dialog";
import { Badge } from "@onecli/ui/components/badge";
import { Button } from "@onecli/ui/components/button";
import { Input } from "@onecli/ui/components/input";
import { Label } from "@onecli/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@onecli/ui/components/select";
import { Switch } from "@onecli/ui/components/switch";
import { Textarea } from "@onecli/ui/components/textarea";
import { cedarPolicy } from "@/lib/api";
import type {
  CedarPolicyGroup,
  CedarPolicyRule,
  CedarPolicySummary,
  CedarValidation,
} from "@/lib/api/cedar-policy";

/**
 * Local addition: the workspace's Cedar policies in groups. Groups and
 * policies each have an on/off switch, edit, and delete; a policy applies only
 * when it and its group are both on. Every save is checked by the gateway's own
 * Cedar parser.
 */

export const POLICY_QUERY_KEY = ["cedar-policy"] as const;

const NEW_POLICY = `permit(
  principal,
  action == OneCLI::Action::"GET",
  resource == OneCLI::Host::"example.com"
);`;

const errorText = (err: unknown, fallback: string) =>
  err instanceof Error ? err.message : fallback;

/** Policies the gateway currently applies (on, in a group that is on). */
export const activeCount = (groups: CedarPolicyGroup[]) =>
  groups.reduce((n, g) => n + (g.enabled ? g.policies.filter((p) => p.enabled).length : 0), 0);

const useRefresh = () => {
  const queryClient = useQueryClient();
  return () => void queryClient.invalidateQueries({ queryKey: POLICY_QUERY_KEY });
};

const Modifiers = ({ summary }: { summary: CedarPolicySummary }) => (
  <>
    <Badge variant={summary.effect === "forbid" ? "destructive" : "secondary"}>
      {summary.effect}
    </Badge>
    {summary.approval && <Badge variant="outline">needs approval</Badge>}
    {summary.rate_limit && <Badge variant="outline">rate limit {summary.rate_limit}</Badge>}
  </>
);

const DeleteButton = ({
  title,
  description,
  onConfirm,
}: {
  title: string;
  description: string;
  onConfirm: () => void;
}) => (
  <AlertDialog>
    <AlertDialogTrigger asChild>
      <Button variant="ghost" size="sm" className="text-destructive">
        Delete
      </Button>
    </AlertDialogTrigger>
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>{title}</AlertDialogTitle>
        <AlertDialogDescription>{description}</AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel>Cancel</AlertDialogCancel>
        <AlertDialogAction onClick={onConfirm}>Delete</AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
);

// ── Policies ────────────────────────────────────────────────────────────────

/** Create or edit form. `initial` absent = a new policy in `groupId`. */
const PolicyForm = ({
  groupId,
  groups,
  initial,
  onDone,
}: {
  groupId: string;
  groups: CedarPolicyGroup[];
  initial?: CedarPolicyRule;
  onDone: () => void;
}) => {
  const refresh = useRefresh();
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [text, setText] = useState(initial?.policyText ?? NEW_POLICY);
  const [targetGroup, setTargetGroup] = useState(groupId);
  const [checked, setChecked] = useState<CedarValidation | null>(null);
  const groupName = groups.find((g) => g.id === targetGroup)?.name ?? "group";

  const validate = useMutation({
    mutationFn: () => cedarPolicy.validate(`${groupName}/${name || "policy"}`, text),
    onSuccess: setChecked,
    onError: (err) => toast.error(errorText(err, "Validation failed")),
  });

  const save = useMutation({
    mutationFn: () => {
      const input = {
        groupId: targetGroup,
        name: name.trim(),
        description: description.trim() || null,
        policyText: text,
      };
      return initial ? cedarPolicy.update(initial.id, input) : cedarPolicy.create(input);
    },
    onSuccess: () => {
      toast.success(initial ? "Policy saved" : "Policy added");
      refresh();
      onDone();
    },
    onError: (err) => toast.error(errorText(err, "Could not save")),
  });

  return (
    <div className="flex flex-col gap-3 rounded-md border p-4">
      <div className={`grid gap-3 ${initial ? "sm:grid-cols-3" : "sm:grid-cols-2"}`}>
        <div className="grid gap-1.5">
          <Label htmlFor="policy-name">Name</Label>
          <Input
            id="policy-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="read-wikipedia"
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="policy-description">Description (optional)</Label>
          <Input
            id="policy-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
        {initial && (
          <div className="grid gap-1.5">
            <Label>Group</Label>
            <Select value={targetGroup} onValueChange={setTargetGroup}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {groups.map((g) => (
                  <SelectItem key={g.id} value={g.id}>
                    {g.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
      </div>
      <Textarea
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setChecked(null);
        }}
        spellCheck={false}
        rows={Math.min(24, Math.max(6, text.split("\n").length + 1))}
        className="font-mono text-xs"
        aria-label="Cedar policy"
      />
      {checked && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {checked.valid ? (
            <>
              <span className="text-muted-foreground">Valid:</span>
              <Modifiers summary={checked.policy} />
            </>
          ) : (
            <pre className="border-destructive bg-destructive/5 text-destructive w-full overflow-x-auto rounded-md border p-2 text-xs whitespace-pre-wrap">
              {checked.error}
            </pre>
          )}
        </div>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onDone} disabled={save.isPending}>
          Cancel
        </Button>
        <Button variant="outline" onClick={() => validate.mutate()} disabled={validate.isPending}>
          {validate.isPending ? "Checking..." : "Validate"}
        </Button>
        <Button onClick={() => save.mutate()} disabled={save.isPending || !name.trim()}>
          {save.isPending ? "Saving..." : initial ? "Save" : "Add policy"}
        </Button>
      </div>
    </div>
  );
};

const PolicyRow = ({
  policy,
  group,
  groups,
}: {
  policy: CedarPolicyRule;
  group: CedarPolicyGroup;
  groups: CedarPolicyGroup[];
}) => {
  const refresh = useRefresh();
  const [editing, setEditing] = useState(false);
  const [showCode, setShowCode] = useState(false);

  const toggle = useMutation({
    mutationFn: (enabled: boolean) => cedarPolicy.update(policy.id, { enabled }),
    onSuccess: (_row, enabled) => {
      toast.success(`${group.name}/${policy.name} ${enabled ? "on" : "off"}`);
      refresh();
    },
    onError: (err) => toast.error(errorText(err, "Could not switch the policy")),
  });

  const remove = useMutation({
    mutationFn: () => cedarPolicy.remove(policy.id),
    onSuccess: () => {
      toast.success(`${group.name}/${policy.name} deleted`);
      refresh();
    },
    onError: (err) => toast.error(errorText(err, "Could not delete")),
  });

  if (editing) {
    return (
      <div className="p-3">
        <PolicyForm groupId={group.id} groups={groups} initial={policy} onDone={() => setEditing(false)} />
      </div>
    );
  }

  const active = policy.enabled && group.enabled;
  const invalid = policy.validation && !policy.validation.valid;
  return (
    <div className={`px-4 py-2.5 ${active ? "" : "opacity-60"}`}>
      <div className="flex flex-wrap items-center gap-2">
        <Switch
          checked={policy.enabled}
          disabled={toggle.isPending}
          onCheckedChange={(on) => toggle.mutate(on)}
          aria-label={`Turn ${policy.name} ${policy.enabled ? "off" : "on"}`}
        />
        <button
          type="button"
          className="font-mono text-sm font-medium hover:underline"
          onClick={() => setShowCode((v) => !v)}
          aria-expanded={showCode}
        >
          {policy.name}
        </button>
        {policy.validation?.valid && <Modifiers summary={policy.validation.policy} />}
        {invalid && <Badge variant="destructive">invalid</Badge>}
        {policy.enabled && !group.enabled && <Badge variant="outline">group off</Badge>}
        {policy.description && (
          <span className="text-muted-foreground min-w-0 flex-1 truncate text-sm" title={policy.description}>
            {policy.description}
          </span>
        )}
        <div className="ml-auto flex gap-1">
          <Button variant="ghost" size="sm" onClick={() => setShowCode((v) => !v)}>
            {showCode ? "Hide code" : "Code"}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
            Edit
          </Button>
          <DeleteButton
            title={`Delete ${group.name}/${policy.name}?`}
            description="The gateway stops applying it within seconds. Switch it off instead to keep the code."
            onConfirm={() => remove.mutate()}
          />
        </div>
      </div>
      {showCode && (
        <pre className="bg-muted mt-2 overflow-x-auto rounded-md p-3 font-mono text-xs leading-relaxed">
          {policy.policyText}
        </pre>
      )}
      {invalid && (
        <p className="text-destructive mt-1 text-xs">
          Not valid — the gateway blocks everything while this is on: {policy.validation?.valid === false && policy.validation.error}
        </p>
      )}
    </div>
  );
};

// ── Groups ──────────────────────────────────────────────────────────────────

/** Create or edit a group's name, description, and source key. */
const GroupForm = ({
  initial,
  onDone,
}: {
  initial?: CedarPolicyGroup;
  onDone: () => void;
}) => {
  const refresh = useRefresh();
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [source, setSource] = useState(initial?.source ?? "");

  const save = useMutation({
    mutationFn: () => {
      const input = {
        name: name.trim(),
        description: description.trim() || null,
        source: source.trim() || null,
      };
      return initial ? cedarPolicy.updateGroup(initial.id, input) : cedarPolicy.createGroup(input);
    },
    onSuccess: () => {
      toast.success(initial ? "Group saved" : "Group added");
      refresh();
      onDone();
    },
    onError: (err) => toast.error(errorText(err, "Could not save the group")),
  });

  return (
    <div className="flex flex-col gap-3 rounded-md border p-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="grid gap-1.5">
          <Label htmlFor="group-name">Group name</Label>
          <Input
            id="group-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="web-research"
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="group-description">Description (optional)</Label>
          <Input
            id="group-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="group-source">Source key (optional)</Label>
          <Input
            id="group-source"
            value={source}
            onChange={(e) => setSource(e.target.value)}
            placeholder="skill:agent-browser"
          />
        </div>
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onDone} disabled={save.isPending}>
          Cancel
        </Button>
        <Button onClick={() => save.mutate()} disabled={save.isPending || !name.trim()}>
          {save.isPending ? "Saving..." : initial ? "Save group" : "Add group"}
        </Button>
      </div>
    </div>
  );
};

const GroupSwitch = ({ group }: { group: CedarPolicyGroup }) => {
  const refresh = useRefresh();
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => cedarPolicy.updateGroup(group.id, { enabled }),
    onSuccess: (_row, enabled) => {
      toast.success(`Group ${group.name} ${enabled ? "on" : "off"}`);
      refresh();
    },
    onError: (err) => toast.error(errorText(err, "Could not switch the group")),
  });
  return (
    <Switch
      checked={group.enabled}
      disabled={toggle.isPending}
      onCheckedChange={(next) => toggle.mutate(next)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      aria-label={`Turn group ${group.name} ${group.enabled ? "off" : "on"}`}
    />
  );
};

const countOn = (group: CedarPolicyGroup) => group.policies.filter((p) => p.enabled).length;

/** All groups, one clickable row each. */
const GroupList = ({
  groups,
  onOpen,
}: {
  groups: CedarPolicyGroup[];
  onOpen: (id: string) => void;
}) => (
  <div className="divide-y rounded-lg border">
    {groups.map((g) => (
      <div
        key={g.id}
        role="button"
        tabIndex={0}
        onClick={() => onOpen(g.id)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") onOpen(g.id);
        }}
        className={`hover:bg-muted/50 flex cursor-pointer flex-wrap items-center gap-3 px-4 py-3 ${g.enabled ? "" : "opacity-60"}`}
      >
        <GroupSwitch group={g} />
        <span className="font-medium">{g.name}</span>
        {g.source && <Badge variant="outline">{g.source}</Badge>}
        {g.description && (
          <span className="text-muted-foreground min-w-0 flex-1 truncate text-sm" title={g.description}>
            {g.description}
          </span>
        )}
        <span className="text-muted-foreground ml-auto shrink-0 text-sm tabular-nums">
          {g.enabled ? `${countOn(g)} of ${g.policies.length} on` : `off · ${g.policies.length} policies`}
        </span>
        <span className="text-muted-foreground" aria-hidden>
          ›
        </span>
      </div>
    ))}
    {groups.length === 0 && <p className="text-muted-foreground p-4 text-sm">No groups yet.</p>}
  </div>
);

const PAGE_SIZE = 25;

/** One group: header, search, on/off filter, and paged policy rows. */
const GroupDetail = ({
  group,
  groups,
  onBack,
}: {
  group: CedarPolicyGroup;
  groups: CedarPolicyGroup[];
  onBack: () => void;
}) => {
  const refresh = useRefresh();
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "on" | "off">("all");
  const [page, setPage] = useState(0);

  const remove = useMutation({
    mutationFn: () => cedarPolicy.removeGroup(group.id),
    onSuccess: () => {
      toast.success(`Group ${group.name} deleted`);
      refresh();
      onBack();
    },
    onError: (err) => toast.error(errorText(err, "Could not delete the group")),
  });

  const q = query.trim().toLowerCase();
  const shown = group.policies.filter(
    (p) =>
      (filter === "all" || (filter === "on") === p.enabled) &&
      (!q || [p.name, p.description ?? "", p.policyText].some((t) => t.toLowerCase().includes(q))),
  );
  const pages = Math.max(1, Math.ceil(shown.length / PAGE_SIZE));
  const current = Math.min(page, pages - 1);
  const slice = shown.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE);

  return (
    <div className="flex flex-col gap-3">
      <div>
        <Button variant="ghost" size="sm" onClick={onBack}>
          ‹ All groups
        </Button>
      </div>
      <div className="rounded-lg border">
        {editing ? (
          <div className="p-3">
            <GroupForm initial={group} onDone={() => setEditing(false)} />
          </div>
        ) : (
          <div className="bg-muted/40 flex flex-wrap items-center gap-2 border-b px-4 py-3">
            <GroupSwitch group={group} />
            <span className="font-medium">{group.name}</span>
            {group.source && <Badge variant="outline">{group.source}</Badge>}
            <span className="text-muted-foreground text-sm">
              {group.enabled ? `${countOn(group)} of ${group.policies.length} on` : "off — none of its policies apply"}
            </span>
            <div className="ml-auto flex gap-1">
              <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
                Edit
              </Button>
              <DeleteButton
                title={`Delete group ${group.name}?`}
                description={`This also deletes its ${group.policies.length} ${group.policies.length === 1 ? "policy" : "policies"}. Switch the group off instead to keep them.`}
                onConfirm={() => remove.mutate()}
              />
            </div>
            {group.description && <p className="text-muted-foreground w-full text-sm">{group.description}</p>}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2">
          <Input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(0);
            }}
            placeholder="Search name, description, or code"
            className="h-8 max-w-xs"
            aria-label="Search policies"
          />
          <div className="flex gap-1" role="group" aria-label="Filter">
            {(["all", "on", "off"] as const).map((f) => (
              <Button
                key={f}
                size="sm"
                variant={filter === f ? "secondary" : "ghost"}
                onClick={() => {
                  setFilter(f);
                  setPage(0);
                }}
              >
                {f === "all" ? "All" : f === "on" ? "On" : "Off"}
              </Button>
            ))}
          </div>
          <span className="text-muted-foreground text-sm tabular-nums">
            {shown.length === 0
              ? "no matches"
              : `${current * PAGE_SIZE + 1}–${current * PAGE_SIZE + slice.length} of ${shown.length}`}
          </span>
          <div className="ml-auto flex gap-1">
            <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
              Add policy
            </Button>
          </div>
        </div>

        {adding && (
          <div className="border-b p-3">
            <PolicyForm groupId={group.id} groups={groups} onDone={() => setAdding(false)} />
          </div>
        )}
        <div className="divide-y">
          {slice.map((p) => (
            <PolicyRow key={p.id} policy={p} group={group} groups={groups} />
          ))}
          {group.policies.length === 0 && !adding && (
            <p className="text-muted-foreground p-4 text-sm">No policies in this group.</p>
          )}
        </div>

        {pages > 1 && (
          <div className="flex items-center justify-end gap-2 border-t px-4 py-2">
            <Button variant="outline" size="sm" disabled={current === 0} onClick={() => setPage(current - 1)}>
              Previous
            </Button>
            <span className="text-muted-foreground text-sm tabular-nums">
              Page {current + 1} of {pages}
            </span>
            <Button variant="outline" size="sm" disabled={current >= pages - 1} onClick={() => setPage(current + 1)}>
              Next
            </Button>
          </div>
        )}
      </div>
    </div>
  );
};

const Reference = () => (
  <details className="text-sm">
    <summary className="text-muted-foreground cursor-pointer">Cedar reference for this gateway</summary>
    <div className="text-muted-foreground mt-2 space-y-1">
      <p>
        <b>principal</b> <code>OneCLI::Agent::&quot;&lt;id&gt;&quot;</code> — attributes <code>id</code>,{" "}
        <code>identifier</code> (NanoClaw agent group), <code>name</code>; member of{" "}
        <code>OneCLI::Workspace::&quot;&lt;id&gt;&quot;</code>.
      </p>
      <p>
        <b>action</b> <code>OneCLI::Action::&quot;GET&quot;</code>, <code>&quot;POST&quot;</code>, … — exactly the
        HTTP method; several at once: <code>action in [OneCLI::Action::&quot;GET&quot;, OneCLI::Action::&quot;HEAD&quot;]</code>.
      </p>
      <p>
        <b>resource</b> <code>OneCLI::Host::&quot;api.example.com&quot;</code> — attribute <code>name</code>, e.g.{" "}
        <code>resource.name like &quot;*.example.com&quot;</code>.
      </p>
      <p>
        <b>context</b> <code>method</code>, <code>host</code>, <code>port</code>, <code>path</code>,{" "}
        <code>query</code> (record), <code>query_string</code>, <code>headers</code> (record, lower-case),{" "}
        <code>has_body</code>, <code>body</code>, <code>json</code>, <code>body_truncated</code>,{" "}
        <code>has_credential</code>, <code>is_llm_host</code>. Guard optional parts with <code>has</code>.
      </p>
      <p>
        <b>annotations</b> on permit: <code>@approval</code>, <code>@rate_limit(&quot;60/minute&quot;)</code>.
        No policy on, or an invalid one switched on, blocks every request.
      </p>
      <p>
        <b>groups</b> a policy applies only when it and its group are both on. Its Cedar id, shown in
        logs and 403 responses, is <code>group/policy</code>.
      </p>
    </div>
  </details>
);

export const CedarPolicies = ({ groups }: { groups: CedarPolicyGroup[] }) => {
  const [adding, setAdding] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const open = groups.find((g) => g.id === openId) ?? null;
  return (
    <div className="flex flex-col gap-4">
      {activeCount(groups) === 0 && (
        <p className="border-destructive bg-destructive/5 text-destructive rounded-md border p-3 text-sm">
          No policy is on, so every request is blocked — including the model API, so agents cannot run.
        </p>
      )}
      {open ? (
        <GroupDetail group={open} groups={groups} onBack={() => setOpenId(null)} />
      ) : (
        <>
          <GroupList groups={groups} onOpen={setOpenId} />
          {adding ? (
            <GroupForm onDone={() => setAdding(false)} />
          ) : (
            <div>
              <Button variant="outline" onClick={() => setAdding(true)}>
                Add group
              </Button>
            </div>
          )}
        </>
      )}
      <Reference />
    </div>
  );
};
