import type { AgentRef, CedarPolicyGroup } from "@/lib/api/cedar-policy";

/**
 * Which agent a Cedar policy group belongs to, if any.
 *
 * The workspace policy page shows only universal groups (policies any agent can
 * match); each agent's own page shows the groups written for it alone. A group
 * belongs to an agent when every policy in it names that one agent as principal
 * (`principal == OneCLI::Agent::"<id>"`). An empty group has no policy to read,
 * so its source key decides: a source ending in `@<agent identifier>` (e.g.
 * `skill:agent-browser@my-agent`) marks it as that agent's.
 */

const PRINCIPAL_AGENT =
  /\b(?:permit|forbid)\s*\(\s*principal\s*==\s*OneCLI::Agent::"([^"]+)"/;
const SOURCE_AGENT = /@([^@\s]+)$/;

/** The agent id a policy's principal names, or null for any other principal. */
export const policyAgentId = (policyText: string): string | null =>
  PRINCIPAL_AGENT.exec(policyText)?.[1] ?? null;

/** The agent a group belongs to, or null when the group is universal. A group whose
 *  agent no longer exists counts as universal, so it stays visible somewhere. */
export const groupAgent = (
  group: CedarPolicyGroup,
  agents: AgentRef[],
): AgentRef | null => {
  if (group.policies.length > 0) {
    const ids = new Set(group.policies.map((p) => policyAgentId(p.policyText)));
    if (ids.size !== 1) return null;
    const [id] = [...ids];
    return id ? (agents.find((a) => a.id === id) ?? null) : null;
  }
  const identifier = group.source
    ? SOURCE_AGENT.exec(group.source)?.[1]
    : undefined;
  return identifier
    ? (agents.find((a) => a.identifier === identifier) ?? null)
    : null;
};

/** A new policy's starting text, scoped to an agent when one is given. */
export const newPolicyText = (agent: AgentRef | null): string => `permit(
  ${agent ? `principal == OneCLI::Agent::"${agent.id}"` : "principal"},
  action == OneCLI::Action::"GET",
  resource == OneCLI::Host::"example.com"
);`;

/** The source key a group created on an agent's page gets, so it stays on that page
 *  while it has no policies yet. */
export const agentGroupSource = (name: string, agent: AgentRef): string =>
  `custom:${name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")}@${agent.identifier}`;
