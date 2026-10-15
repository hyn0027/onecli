/**
 * Local addition: the workspace's Cedar policy document and the gateway's
 * enforcement posture, for the dashboard's Workspace Settings → Policy page.
 *
 *   GET  /v1/cedar-policy           document, parsed entries, gateway status,
 *                                   and the published rule-engine rules
 *   POST /v1/cedar-policy/validate  parse-check a draft (nothing is saved)
 *   PUT  /v1/cedar-policy           validate, then save (workspace managers)
 *
 * Parsing is done by the gateway (`/v1/cedar/validate`) so the dashboard and
 * enforcement can never disagree about what a document means. The gateway
 * enforces the document only when it runs with GATEWAY_POLICY_ENGINE=cedar.
 */
import { Hono } from "hono";
import { z } from "zod";
import { db } from "@onecli/db";
import type { ApiEnv } from "../types";
import { authMiddleware, requireWorkspaceId } from "../middleware/auth";
import { requireWorkspaceManagement } from "../ee/services/workspace-management-guard";
import { ServiceError } from "../services/errors";
import { getGatewayInternalUrl } from "../lib/env";
import { invalidateGatewayCache } from "../lib/gateway-invalidate";

/** Largest document accepted (characters). */
const MAX_POLICY_LENGTH = 200_000;

const policyBody = z.object({
  policyText: z.string().max(MAX_POLICY_LENGTH),
});

const parseBody = (raw: unknown) => {
  const parsed = policyBody.safeParse(raw);
  if (!parsed.success) {
    throw new ServiceError(
      "BAD_REQUEST",
      `policyText must be a string of at most ${MAX_POLICY_LENGTH} characters`,
    );
  }
  return parsed.data;
};

interface PolicySummary {
  id: string;
  name: string;
  effect: "permit" | "forbid";
  approval: boolean;
  rate_limit: string | null;
}

type Validation =
  | { valid: true; policies: PolicySummary[] }
  | { valid: false; error: string };

interface GatewayStatus {
  engine: "cedar" | "rules";
  strictDeny: boolean;
}

/** The caller's own credentials, forwarded so the gateway authenticates them. */
const forwardedAuth = (request: Request): Record<string, string> => {
  const headers: Record<string, string> = {};
  for (const name of ["authorization", "cookie", "x-workspace-id"]) {
    const value = request.headers.get(name);
    if (value) headers[name] = value;
  }
  return headers;
};

const validateWithGateway = async (
  request: Request,
  policyText: string,
): Promise<Validation> => {
  const res = await fetch(`${getGatewayInternalUrl()}/v1/cedar/validate`, {
    method: "POST",
    headers: { ...forwardedAuth(request), "content-type": "application/json" },
    body: JSON.stringify({ policy_text: policyText }),
  });
  if (!res.ok) {
    throw new ServiceError(
      "UNPROCESSABLE",
      `The gateway could not validate the policy (HTTP ${res.status})`,
    );
  }
  return (await res.json()) as Validation;
};

const gatewayStatus = async (
  request: Request,
): Promise<GatewayStatus | null> => {
  try {
    const res = await fetch(`${getGatewayInternalUrl()}/v1/cedar/status`, {
      headers: forwardedAuth(request),
    });
    return res.ok ? ((await res.json()) as GatewayStatus) : null;
  } catch {
    return null;
  }
};

/** The workspace's currently published rule-engine rules, in decision order. */
const publishedRules = async (workspaceId: string) => {
  const agg = await db.policyRuleV2.aggregate({
    where: { scope: "workspace", workspaceId, status: "published" },
    _max: { generation: true },
  });
  const generation = agg._max.generation;
  if (generation === null) return { generation: null, rules: [] };
  const rows = await db.policyRuleV2.findMany({
    where: {
      scope: "workspace",
      workspaceId,
      status: "published",
      generation,
    },
    orderBy: { priority: "asc" },
    select: {
      name: true,
      action: true,
      isDefault: true,
      enabled: true,
      requireApproval: true,
      rateLimit: true,
      rateLimitWindow: true,
      source: true,
      identities: { select: { agentId: true, userId: true, groupId: true } },
      targets: {
        select: {
          kind: true,
          hostPattern: true,
          pathPattern: true,
          method: true,
          appProvider: true,
          secretId: true,
          secretScope: true,
        },
      },
    },
  });
  return { generation, rules: rows };
};

export const cedarPolicyRoutes = () => {
  const app = new Hono<ApiEnv>();
  app.use("*", authMiddleware);

  app.get("/", async (c) => {
    const workspaceId = requireWorkspaceId(c.get("auth"));
    const [row, status, published] = await Promise.all([
      db.cedarPolicy.findUnique({
        where: { workspaceId },
        select: { policyText: true, updatedAt: true },
      }),
      gatewayStatus(c.req.raw),
      publishedRules(workspaceId),
    ]);
    const validation = row
      ? await validateWithGateway(c.req.raw, row.policyText).catch(
          (err: unknown) =>
            ({
              valid: false,
              error: err instanceof Error ? err.message : String(err),
            }) as Validation,
        )
      : null;
    return c.json({
      policyText: row?.policyText ?? null,
      updatedAt: row?.updatedAt ?? null,
      validation,
      gateway: status,
      rules: published,
    });
  });

  app.post("/validate", async (c) => {
    requireWorkspaceId(c.get("auth"));
    const body = parseBody(await c.req.json().catch(() => null));
    return c.json(await validateWithGateway(c.req.raw, body.policyText));
  });

  app.put("/", async (c) => {
    const auth = c.get("auth");
    const workspaceId = requireWorkspaceId(auth);
    await requireWorkspaceManagement(auth, workspaceId);
    const body = parseBody(await c.req.json().catch(() => null));
    const validation = await validateWithGateway(c.req.raw, body.policyText);
    if (!validation.valid) {
      throw new ServiceError("BAD_REQUEST", validation.error);
    }
    const saved = await db.cedarPolicy.upsert({
      where: { workspaceId },
      create: {
        workspaceId,
        policyText: body.policyText,
        updatedByUserId: auth.userId,
      },
      update: { policyText: body.policyText, updatedByUserId: auth.userId },
      select: { updatedAt: true },
    });
    // Drops the gateway's cached copy so the new document applies at once.
    invalidateGatewayCache(c.req.raw);
    return c.json({ updatedAt: saved.updatedAt, validation });
  });

  return app;
};
