import { describe, expect, it } from "vitest";
import type { AgentRef, CedarPolicyGroup } from "@/lib/api/cedar-policy";
import {
  agentGroupSource,
  groupAgent,
  newPolicyText,
  policyAgentId,
} from "./cedar-scope";

const nano: AgentRef = { id: "98190c38", name: "Nano", identifier: "ag-nano" };
const term: AgentRef = {
  id: "c7264987",
  name: "Terminal Agent",
  identifier: "ag-term",
};
const agents = [nano, term];
const group = (
  texts: string[],
  source: string | null = null,
): CedarPolicyGroup =>
  ({
    id: "g",
    name: "g",
    description: null,
    enabled: true,
    position: 0,
    source,
    updatedAt: "",
    policies: texts.map((policyText, i) => ({
      id: `p${i}`,
      name: `p${i}`,
      policyText,
    })),
  }) as unknown as CedarPolicyGroup;
const scoped = (id: string) =>
  `permit(\n  principal == OneCLI::Agent::"${id}",\n  action,\n  resource\n);`;

describe("cedar-scope", () => {
  it("reads the agent a policy names", () => {
    expect(policyAgentId(scoped("x"))).toBe("x");
    expect(
      policyAgentId(
        '@rate_limit("1/minute")\nforbid(principal == OneCLI::Agent::"y", action, resource);',
      ),
    ).toBe("y");
    expect(policyAgentId("permit(principal, action, resource);")).toBeNull();
  });

  it("puts a group on an agent's page only when every policy names that agent", () => {
    expect(
      groupAgent(group([scoped(nano.id), scoped(nano.id)]), agents),
    ).toEqual(nano);
    expect(
      groupAgent(group([scoped(nano.id), scoped(term.id)]), agents),
    ).toBeNull();
    expect(
      groupAgent(
        group([scoped(nano.id), "permit(principal, action, resource);"]),
        agents,
      ),
    ).toBeNull();
    expect(
      groupAgent(group(["permit(principal, action, resource);"]), agents),
    ).toBeNull();
    expect(groupAgent(group([scoped("gone")]), agents)).toBeNull();
  });

  it("places an empty group by its source suffix", () => {
    expect(groupAgent(group([], "skill:x@ag-nano"), agents)).toEqual(nano);
    expect(groupAgent(group([], "skill:x"), agents)).toBeNull();
    expect(
      groupAgent(group([], agentGroupSource("My Group", term)), agents),
    ).toEqual(term);
  });

  it("starts new policies scoped on an agent's page", () => {
    expect(newPolicyText(nano)).toContain(
      `principal == OneCLI::Agent::"${nano.id}"`,
    );
    expect(newPolicyText(null)).toMatch(/permit\(\n {2}principal,/);
  });
});
