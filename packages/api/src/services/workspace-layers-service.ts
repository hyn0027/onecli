/**
 * Local addition: two layers — workspace-wide and per agent — for credentials and
 * Cedar policies.
 *
 * Credentials. A secret marked `workspaceShared` is the workspace layer: it is
 * granted to every agent of the workspace except the ones in
 * `sharedExcludedAgentIds`, and agents created later are in. OneCLI injects a
 * credential only through a grant naming the agent (the inject_select law: an
 * unnamed grant injects to nobody), so the workspace layer is realized as ordinary
 * per-agent grants that this service keeps in step: when the share or its
 * exclusions change, and when an agent is created. Grants an agent holds for an
 * unshared secret are its own layer and are never touched here.
 *
 * Policies. A Cedar policy group whose policies name no single agent is the
 * workspace layer; `excludedAgentIds` lists agents that do not use it. The policy
 * text stays as written; the gateway enforces `compiled_text` when set, which is
 * the text with `unless { principal in [<excluded agents>] }` added, so the group
 * simply never matches those agents.
 */
import { db } from "@onecli/db";
import { logger } from "../lib/logger";
import {
  removeSecretGrant,
  setSecretGrant,
  type GrantScope,
} from "./grants-service";
import { autoAttachScope } from "./llm-autoattach-service";
import { withExclusions } from "../lib/cedar-exclusions";

export { withExclusions };

const log = logger.child({ component: "workspace-layers" });

// ── Policies ───────────────────────────────────────────────────────────────

/** Recompute `compiled_text` for every policy of a group. `validate` checks a
 *  compiled statement with the gateway's own parser and throws when it is invalid. */
export const recompileGroup = async (
  groupId: string,
  validate: (name: string, text: string) => Promise<void>,
): Promise<void> => {
  const group = await db.cedarPolicyGroup.findUnique({
    where: { id: groupId },
    select: {
      name: true,
      excludedAgentIds: true,
      workspaceId: true,
      policies: {
        select: { id: true, name: true, policyText: true, compiledText: true },
      },
    },
  });
  if (!group) return;
  // Exclusions of agents that no longer exist are dropped.
  const live = new Set(
    (
      await db.agent.findMany({
        where: {
          workspaceId: group.workspaceId,
          id: { in: group.excludedAgentIds },
        },
        select: { id: true },
      })
    ).map((a) => a.id),
  );
  const excluded = group.excludedAgentIds.filter((id) => live.has(id));
  for (const p of group.policies) {
    const compiled =
      excluded.length > 0 ? withExclusions(p.policyText, excluded) : null;
    if (compiled === p.compiledText) continue;
    if (compiled !== null) await validate(`${group.name}/${p.name}`, compiled);
    await db.cedarPolicyRule.update({
      where: { id: p.id },
      data: { compiledText: compiled },
    });
  }
};

// ── Credentials ────────────────────────────────────────────────────────────

/** Agents of the workspace holding a published-or-draft grant for this secret. */
const grantedAgentIds = async (
  workspaceId: string,
  secretId: string,
): Promise<Set<string>> => {
  const rows = await db.policyRuleV2.findMany({
    where: {
      scope: "workspace",
      workspaceId,
      status: "draft",
      source: "grant",
      targets: { some: { secretId } },
    },
    select: { identities: { select: { agentId: true } } },
  });
  return new Set(
    rows
      .flatMap((r) => r.identities.map((i) => i.agentId))
      .filter((id): id is string => !!id),
  );
};

export interface SharedCredentialChange {
  granted: string[];
  revoked: string[];
}

/**
 * Bring a secret's grants in line with its workspace share.
 *
 * Shared: every agent not excluded gets the grant; an excluded agent loses it.
 * `previous` is the share state before the change: when a secret stops being shared,
 * the agents that had it through the share (every agent not excluded then) lose it.
 */
export const syncSharedSecret = async (
  scope: GrantScope,
  secretId: string,
  userId: string | null,
  previous?: { shared: boolean; excluded: string[] },
): Promise<SharedCredentialChange> => {
  const secret = await db.secret.findFirst({
    where: { id: secretId, workspaceId: scope.workspaceId },
    select: { workspaceShared: true, sharedExcludedAgentIds: true },
  });
  const change: SharedCredentialChange = { granted: [], revoked: [] };
  if (!secret) return change;
  const agents = await db.agent.findMany({
    where: { workspaceId: scope.workspaceId },
    select: { id: true },
  });
  const have = await grantedAgentIds(scope.workspaceId, secretId);
  for (const { id } of agents) {
    let want: boolean | null = null; // null: leave as it is (the agent's own layer)
    if (secret.workspaceShared) {
      want = !secret.sharedExcludedAgentIds.includes(id);
    } else if (previous?.shared && !previous.excluded.includes(id)) {
      want = false; // it had the credential through the share that just ended
    }
    if (want === true && !have.has(id)) {
      await setSecretGrant(scope, id, secretId, userId);
      change.granted.push(id);
    } else if (want === false && have.has(id)) {
      await removeSecretGrant(scope, id, secretId, userId);
      change.revoked.push(id);
    }
  }
  return change;
};

/** Every workspace-wide credential, to a freshly created agent. Never throws. */
export const attachSharedSecretsToNewAgent = async (
  workspaceId: string,
  agentId: string,
  userId: string | null,
): Promise<string[]> => {
  try {
    const scope = await autoAttachScope(workspaceId);
    if (!scope) return [];
    const shared = await db.secret.findMany({
      where: { workspaceId, workspaceShared: true },
      select: { id: true, sharedExcludedAgentIds: true },
    });
    const out: string[] = [];
    for (const s of shared) {
      if (s.sharedExcludedAgentIds.includes(agentId)) continue;
      await setSecretGrant(scope, agentId, s.id, userId);
      out.push(s.id);
    }
    return out;
  } catch (err) {
    log.warn(
      { err, workspaceId, agentId },
      "workspace-wide credentials not attached to new agent",
    );
    return [];
  }
};
