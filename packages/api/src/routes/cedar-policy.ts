/**
 * Local addition: the workspace's Cedar policies (one statement each, with an
 * on/off switch) and the gateway's enforcement posture, for the dashboard's
 * Workspace Settings → Policy page.
 *
 *   GET    /v1/cedar-policy                policies, gateway status, credential
 *                                          grants with their secrets' configuration
 *   POST   /v1/cedar-policy/validate       check one policy (nothing is saved)
 *   POST   /v1/cedar-policy/policies       add a policy        (workspace managers)
 *   PATCH  /v1/cedar-policy/policies/:id   edit / switch on-off (workspace managers)
 *   DELETE /v1/cedar-policy/policies/:id   remove a policy     (workspace managers)
 *
 * Parsing is done by the gateway (`/v1/cedar/validate`) so the dashboard and
 * enforcement can never disagree about what a policy means. The gateway decides
 * every request with the enabled policies; `policy_rules_v2` rules only grant
 * credentials.
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

/** Largest single policy accepted (characters). */
const MAX_POLICY_LENGTH = 50_000;

const nameSchema = z
  .string()
  .trim()
  .min(1, "name is required")
  .max(100, "name must be at most 100 characters")
  .regex(/^[A-Za-z0-9 _.:-]+$/, "name may use letters, digits, spaces, and _ . : -");

const createSchema = z.object({
  name: nameSchema,
  description: z.string().max(500).optional().nullable(),
  policyText: z.string().min(1).max(MAX_POLICY_LENGTH),
  enabled: z.boolean().optional(),
});

const updateSchema = z
  .object({
    name: nameSchema.optional(),
    description: z.string().max(500).optional().nullable(),
    policyText: z.string().min(1).max(MAX_POLICY_LENGTH).optional(),
    enabled: z.boolean().optional(),
  })
  .refine((d) => Object.keys(d).length > 0, "nothing to update");

const validateSchema = z.object({
  name: z.string().max(100).optional(),
  policyText: z.string().max(MAX_POLICY_LENGTH),
});

const parse = <T>(schema: z.ZodType<T>, raw: unknown): T => {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new ServiceError(
      "BAD_REQUEST",
      parsed.error.issues.map((i) => i.message).join("; "),
    );
  }
  return parsed.data;
};

interface PolicySummary {
  effect: "permit" | "forbid";
  approval: boolean;
  rate_limit: string | null;
}

type Validation =
  | { valid: true; policy: PolicySummary }
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
  name: string,
  policyText: string,
): Promise<Validation> => {
  const res = await fetch(`${getGatewayInternalUrl()}/v1/cedar/validate`, {
    method: "POST",
    headers: { ...forwardedAuth(request), "content-type": "application/json" },
    body: JSON.stringify({ name, policy_text: policyText }),
  });
  if (!res.ok) {
    throw new ServiceError(
      "UNPROCESSABLE",
      `The gateway could not validate the policy (HTTP ${res.status})`,
    );
  }
  return (await res.json()) as Validation;
};

/** Validate or throw a 400 carrying the parser's message. */
const requireValid = async (request: Request, name: string, policyText: string) => {
  const v = await validateWithGateway(request, name, policyText);
  if (!v.valid) throw new ServiceError("BAD_REQUEST", v.error);
  return v;
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

/**
 * Configuration of the secrets and agents grants refer to — never a value.
 * `encryptedValue` and `opRef` are deliberately not selected.
 */
const grantContext = async (workspaceId: string) => {
  const workspace = await db.workspace.findUnique({
    where: { id: workspaceId },
    select: { organizationId: true },
  });
  const [secrets, agents] = await Promise.all([
    db.secret.findMany({
      where: {
        OR: [
          { workspaceId },
          ...(workspace
            ? [{ organizationId: workspace.organizationId, scope: "organization" }]
            : []),
        ],
      },
      select: {
        id: true,
        name: true,
        type: true,
        scope: true,
        hostPattern: true,
        pathPattern: true,
        injectionConfig: true,
        valueSource: true,
        metadata: true,
      },
      orderBy: { name: "asc" },
    }),
    db.agent.findMany({
      where: { workspaceId },
      select: { id: true, name: true, identifier: true },
    }),
  ]);
  return {
    secrets: secrets.map(({ metadata, ...s }) => {
      // Only the auth mode is surfaced from metadata (it decides how the
      // gateway injects an Anthropic/OpenAI credential).
      const authMode =
        metadata && typeof metadata === "object" && "authMode" in metadata
          ? String((metadata as Record<string, unknown>).authMode)
          : null;
      return { ...s, authMode };
    }),
    agents,
  };
};

const POLICY_SELECT = {
  id: true,
  name: true,
  description: true,
  policyText: true,
  enabled: true,
  position: true,
  updatedAt: true,
} as const;

/** The policy row, scoped to the caller's workspace (404 otherwise). */
const findPolicy = async (workspaceId: string, id: string) => {
  const row = await db.cedarPolicyRule.findFirst({
    where: { id, workspaceId },
    select: POLICY_SELECT,
  });
  if (!row) throw new ServiceError("NOT_FOUND", "Policy not found");
  return row;
};

const nameTaken = async (workspaceId: string, name: string, exceptId?: string) =>
  (await db.cedarPolicyRule.count({
    where: { workspaceId, name, ...(exceptId ? { NOT: { id: exceptId } } : {}) },
  })) > 0;

export const cedarPolicyRoutes = () => {
  const app = new Hono<ApiEnv>();
  app.use("*", authMiddleware);

  app.get("/", async (c) => {
    const workspaceId = requireWorkspaceId(c.get("auth"));
    const [rows, status, published, grantDetails] = await Promise.all([
      db.cedarPolicyRule.findMany({
        where: { workspaceId },
        orderBy: [{ position: "asc" }, { createdAt: "asc" }],
        select: POLICY_SELECT,
      }),
      gatewayStatus(c.req.raw),
      publishedRules(workspaceId),
      grantContext(workspaceId),
    ]);
    const policies = await Promise.all(
      rows.map(async (row) => ({
        ...row,
        validation: await validateWithGateway(c.req.raw, row.name, row.policyText).catch(
          (err: unknown) =>
            ({
              valid: false,
              error: err instanceof Error ? err.message : String(err),
            }) as Validation,
        ),
      })),
    );
    return c.json({
      policies,
      gateway: status,
      rules: published,
      secrets: grantDetails.secrets,
      agents: grantDetails.agents,
    });
  });

  app.post("/validate", async (c) => {
    requireWorkspaceId(c.get("auth"));
    const body = parse(validateSchema, await c.req.json().catch(() => null));
    return c.json(
      await validateWithGateway(c.req.raw, body.name || "policy", body.policyText),
    );
  });

  app.post("/policies", async (c) => {
    const auth = c.get("auth");
    const workspaceId = requireWorkspaceId(auth);
    await requireWorkspaceManagement(auth, workspaceId);
    const body = parse(createSchema, await c.req.json().catch(() => null));
    if (await nameTaken(workspaceId, body.name)) {
      throw new ServiceError("CONFLICT", `A policy named "${body.name}" already exists`);
    }
    await requireValid(c.req.raw, body.name, body.policyText);
    const last = await db.cedarPolicyRule.aggregate({
      where: { workspaceId },
      _max: { position: true },
    });
    const row = await db.cedarPolicyRule.create({
      data: {
        workspaceId,
        name: body.name,
        description: body.description ?? null,
        policyText: body.policyText,
        enabled: body.enabled ?? true,
        position: (last._max.position ?? -1) + 1,
        updatedByUserId: auth.userId,
      },
      select: POLICY_SELECT,
    });
    invalidateGatewayCache(c.req.raw);
    return c.json(row, 201);
  });

  app.patch("/policies/:id", async (c) => {
    const auth = c.get("auth");
    const workspaceId = requireWorkspaceId(auth);
    await requireWorkspaceManagement(auth, workspaceId);
    const current = await findPolicy(workspaceId, c.req.param("id"));
    const body = parse(updateSchema, await c.req.json().catch(() => null));
    const name = body.name ?? current.name;
    if (name !== current.name && (await nameTaken(workspaceId, name, current.id))) {
      throw new ServiceError("CONFLICT", `A policy named "${name}" already exists`);
    }
    if (body.policyText !== undefined || name !== current.name) {
      await requireValid(c.req.raw, name, body.policyText ?? current.policyText);
    }
    const row = await db.cedarPolicyRule.update({
      where: { id: current.id },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.policyText !== undefined ? { policyText: body.policyText } : {}),
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
        updatedByUserId: auth.userId,
      },
      select: POLICY_SELECT,
    });
    invalidateGatewayCache(c.req.raw);
    return c.json(row);
  });

  app.delete("/policies/:id", async (c) => {
    const auth = c.get("auth");
    const workspaceId = requireWorkspaceId(auth);
    await requireWorkspaceManagement(auth, workspaceId);
    const current = await findPolicy(workspaceId, c.req.param("id"));
    await db.cedarPolicyRule.delete({ where: { id: current.id } });
    invalidateGatewayCache(c.req.raw);
    return c.body(null, 204);
  });

  return app;
};
