import { apiGet, apiPost, apiPut } from "./client";

// Local addition: the workspace's Cedar policy document and the gateway's
// enforcement posture (Workspace Settings → Policy). Workspace comes from the
// URL scope header that apiFetch adds.
const base = "/v1/cedar-policy";

export interface CedarPolicySummary {
  id: string;
  name: string;
  effect: "permit" | "forbid";
  approval: boolean;
  rate_limit: string | null;
}

export type CedarValidation =
  | { valid: true; policies: CedarPolicySummary[] }
  | { valid: false; error: string };

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

export interface CedarPolicyState {
  policyText: string | null;
  updatedAt: string | null;
  validation: CedarValidation | null;
  gateway: { engine: "cedar" | "rules"; strictDeny: boolean } | null;
  rules: { generation: number | null; rules: PublishedRule[] };
}

export const get = () => apiGet<CedarPolicyState>(base);

export const validate = (policyText: string) =>
  apiPost<CedarValidation>(`${base}/validate`, { policyText });

export const save = (policyText: string) =>
  apiPut<{ updatedAt: string; validation: CedarValidation }>(base, {
    policyText,
  });
