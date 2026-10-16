import { apiDelete, apiGet, apiPatch, apiPost } from "./client";

// Local addition: the workspace's Cedar policies (one statement each, in groups)
// and the gateway's enforcement posture (Workspace Settings → Policy). Workspace comes from the
// URL scope header that apiFetch adds.
const base = "/v1/cedar-policy";

export interface CedarPolicySummary {
  effect: "permit" | "forbid";
  approval: boolean;
  rate_limit: string | null;
}

export type CedarValidation =
  | { valid: true; policy: CedarPolicySummary }
  | { valid: false; error: string };

/** One Cedar policy statement with its on/off switch. */
export interface CedarPolicyRule {
  id: string;
  groupId: string;
  name: string;
  description: string | null;
  policyText: string;
  enabled: boolean;
  position: number;
  updatedAt: string;
  validation?: CedarValidation;
}

/** A named group of policies with its own on/off switch. */
export interface CedarPolicyGroup {
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  position: number;
  /** Machine key of the tooling that manages the group, e.g. "skill:agent-browser". */
  source: string | null;
  updatedAt: string;
  policies: CedarPolicyRule[];
}

export interface PublishedRule {
  name: string;
  action: string;
  isDefault: boolean;
  enabled: boolean;
  requireApproval: boolean;
  rateLimit: number | null;
  rateLimitWindow: string | null;
  source: string;
  identities: { agentId: string | null; userId: string | null; groupId: string | null }[];
  targets: {
    kind: string;
    hostPattern: string | null;
    pathPattern: string | null;
    method: string | null;
    appProvider: string | null;
    secretId: string | null;
    secretScope: string | null;
  }[];
}

/** A stored secret's configuration — never its value. */
export interface SecretConfig {
  id: string;
  name: string;
  type: string;
  scope: string;
  hostPattern: string;
  pathPattern: string | null;
  injectionConfig: Record<string, unknown> | null;
  valueSource: string;
  authMode: string | null;
}

export interface AgentRef {
  id: string;
  name: string;
  identifier: string;
}

export interface CedarPolicyState {
  groups: CedarPolicyGroup[];
  gateway: { engine: "cedar" | "rules"; strictDeny: boolean } | null;
  rules: { generation: number | null; rules: PublishedRule[] };
  secrets: SecretConfig[];
  agents: AgentRef[];
}

export const get = () => apiGet<CedarPolicyState>(base);

export const validate = (name: string, policyText: string) =>
  apiPost<CedarValidation>(`${base}/validate`, { name, policyText });

export interface PolicyInput {
  groupId: string;
  name: string;
  description?: string | null;
  policyText: string;
  enabled?: boolean;
}

export const create = (input: PolicyInput) =>
  apiPost<CedarPolicyRule>(`${base}/policies`, input);

export const update = (id: string, input: Partial<PolicyInput>) =>
  apiPatch<CedarPolicyRule>(`${base}/policies/${id}`, input);

export const remove = (id: string) => apiDelete(`${base}/policies/${id}`);

export interface GroupInput {
  name: string;
  description?: string | null;
  enabled?: boolean;
  source?: string | null;
}

export const createGroup = (input: GroupInput) =>
  apiPost<CedarPolicyGroup>(`${base}/groups`, input);

export const updateGroup = (id: string, input: Partial<GroupInput>) =>
  apiPatch<CedarPolicyGroup>(`${base}/groups/${id}`, input);

export const removeGroup = (id: string) => apiDelete(`${base}/groups/${id}`);
