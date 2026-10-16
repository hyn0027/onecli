/**
 * Local addition: the workspace's Cedar policies, organized in groups, and the
 * gateway's enforcement posture, for the dashboard's Workspace Settings →
 * Policy page and for scripts (API key auth works too).
 *
 * Every policy (one Cedar statement) belongs to a group. A policy applies only
 * when it and its group are both switched on; its Cedar id is "group/policy".
 *
 *   GET    /v1/cedar-policy                 groups with their policies, gateway
 *                                           status, credential grants with their
 *                                           secrets' configuration
 *   POST   /v1/cedar-policy/validate        check one policy (nothing is saved)
 *   POST   /v1/cedar-policy/groups          add a group
 *   PUT    /v1/cedar-policy/groups/sync     create or replace a group and all its
 *                                           policies in one step, keyed by `source`
 *                                           (e.g. "skill:agent-browser") or name
 *   PATCH  /v1/cedar-policy/groups/:id      rename / describe / switch a group
 *   DELETE /v1/cedar-policy/groups/:id      remove a group and its policies
 *   POST   /v1/cedar-policy/policies        add a policy to a group
 *   PATCH  /v1/cedar-policy/policies/:id    edit / switch / move a policy
 *   DELETE /v1/cedar-policy/policies/:id    remove a policy
 *
 * Writes need workspace management rights. Parsing is done by the gateway
 * (`/v1/cedar/validate`) so the dashboard and enforcement can never disagree
 * about what a policy means. The gateway decides every request with the
 * policies that are on; `policy_rules_v2` rules only grant credentials.
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

const descriptionSchema = z.string().max(500).optional().nullable();
const policyTextSchema = z.string().min(1).max(MAX_POLICY_LENGTH);
const sourceSchema = z.string().trim().min(1).max(200).optional().nullable();

const createSchema = z.object({
  groupId: z.string().min(1, "groupId is required"),
  name: nameSchema,
  description: descriptionSchema,
  policyText: policyTextSchema,
  enabled: z.boolean().optional(),
});

const updateSchema = z
  .object({
    groupId: z.string().min(1).optional(),
    name: nameSchema.optional(),
    description: descriptionSchema,
    policyText: policyTextSchema.optional(),
    enabled: z.boolean().optional(),
  })
  .refine((d) => Object.keys(d).length > 0, "nothing to update");

const groupCreateSchema = z.object({
  name: nameSchema,
  description: descriptionSchema,
  enabled: z.boolean().optional(),
  source: sourceSchema,
});

const groupUpdateSchema = z
  .object({
    name: nameSchema.optional(),
    description: descriptionSchema,
    enabled: z.boolean().optional(),
    source: sourceSchema,
  })
  .refine((d) => Object.keys(d).length > 0, "nothing to update");

const groupSyncSchema = z
  .object({
    source: sourceSchema,
    name: nameSchema,
    description: descriptionSchema,
    enabled: z.boolean().optional(),
    policies: z
      .array(
        z.object({
          name: nameSchema,
          description: descriptionSchema,
          policyText: policyTextSchema,
          enabled: z.boolean().optional(),
        }),
      )
      .max(200),
  })
  .refine(
    (d) => new Set(d.policies.map((p) => p.name)).size === d.policies.length,
    "policy names must be unique within the group",
  );

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
  groupId: true,
  name: true,
  description: true,
  policyText: true,
  enabled: true,
  position: true,
  updatedAt: true,
} as const;

const GROUP_SELECT = {
  id: true,
  name: true,
  description: true,
  enabled: true,
  position: true,
  source: true,
  updatedAt: true,
} as const;

/** The policy row, scoped to the caller's workspace (404 otherwise). */
const findPolicy = async (workspaceId: string, id: string) => {
  const row = await db.cedarPolicyRule.findFirst({
    where: { id, workspaceId },
    select: { ...POLICY_SELECT, group: { select: { name: true } } },
  });
  if (!row) throw new ServiceError("NOT_FOUND", "Policy not found");
  return row;
};

/** The group row, scoped to the caller's workspace (404 otherwise). */
const findGroup = async (workspaceId: string, id: string) => {
  const row = await db.cedarPolicyGroup.findFirst({
    where: { id, workspaceId },
    select: GROUP_SELECT,
  });
  if (!row) throw new ServiceError("NOT_FOUND", "Policy group not found");
  return row;
};

const policyNameTaken = async (groupId: string, name: string, exceptId?: string) =>
  (await db.cedarPolicyRule.count({
    where: { groupId, name, ...(exceptId ? { NOT: { id: exceptId } } : {}) },
  })) > 0;

const groupNameTaken = async (workspaceId: string, name: string, exceptId?: string) =>
  (await db.cedarPolicyGroup.count({
    where: { workspaceId, name, ...(exceptId ? { NOT: { id: exceptId } } : {}) },
  })) > 0;

const groupSourceTaken = async (workspaceId: string, source: string, exceptId?: string) =>
  (await db.cedarPolicyGroup.count({
    where: { workspaceId, source, ...(exceptId ? { NOT: { id: exceptId } } : {}) },
  })) > 0;

/** The Cedar id the gateway gives a policy. */
const cedarId = (group: string, policy: string) => `${group}/${policy}`;

const nextGroupPosition = async (workspaceId: string) =>
  ((
    await db.cedarPolicyGroup.aggregate({ where: { workspaceId }, _max: { position: true } })
  )._max.position ?? -1) + 1;

export const cedarPolicyRoutes = () => {
  const app = new Hono<ApiEnv>();
  app.use("*", authMiddleware);

  app.get("/", async (c) => {
    const workspaceId = requireWorkspaceId(c.get("auth"));
    const [groups, status, published, grantDetails] = await Promise.all([
      db.cedarPolicyGroup.findMany({
        where: { workspaceId },
        orderBy: [{ position: "asc" }, { createdAt: "asc" }],
        select: {
          ...GROUP_SELECT,
          policies: {
            orderBy: [{ position: "asc" }, { createdAt: "asc" }],
            select: POLICY_SELECT,
          },
        },
      }),
      gatewayStatus(c.req.raw),
      publishedRules(workspaceId),
      grantContext(workspaceId),
    ]);
    const withValidation = await Promise.all(
      groups.map(async (group) => ({
        ...group,
        policies: await Promise.all(
          group.policies.map(async (row) => ({
            ...row,
            validation: await validateWithGateway(
              c.req.raw,
              cedarId(group.name, row.name),
              row.policyText,
            ).catch(
              (err: unknown) =>
                ({
                  valid: false,
                  error: err instanceof Error ? err.message : String(err),
                }) as Validation,
            ),
          })),
        ),
      })),
    );
    return c.json({
      groups: withValidation,
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

  // ── Groups ────────────────────────────────────────────────────────────────

  app.post("/groups", async (c) => {
    const auth = c.get("auth");
    const workspaceId = requireWorkspaceId(auth);
    await requireWorkspaceManagement(auth, workspaceId);
    const body = parse(groupCreateSchema, await c.req.json().catch(() => null));
    if (await groupNameTaken(workspaceId, body.name)) {
      throw new ServiceError("CONFLICT", `A group named "${body.name}" already exists`);
    }
    if (body.source && (await groupSourceTaken(workspaceId, body.source))) {
      throw new ServiceError("CONFLICT", `A group with source "${body.source}" already exists`);
    }
    const row = await db.cedarPolicyGroup.create({
      data: {
        workspaceId,
        name: body.name,
        description: body.description ?? null,
        enabled: body.enabled ?? true,
        source: body.source ?? null,
        position: await nextGroupPosition(workspaceId),
        updatedByUserId: auth.userId,
      },
      select: GROUP_SELECT,
    });
    invalidateGatewayCache(c.req.raw);
    return c.json(row, 201);
  });

  // Create or replace a whole group: found by `source` when given, else by
  // name. Its policies become exactly the ones sent. Everything is validated
  // before anything is written, and the write is one transaction.
  app.put("/groups/sync", async (c) => {
    const auth = c.get("auth");
    const workspaceId = requireWorkspaceId(auth);
    await requireWorkspaceManagement(auth, workspaceId);
    const body = parse(groupSyncSchema, await c.req.json().catch(() => null));
    const existing = await db.cedarPolicyGroup.findFirst({
      where: body.source ? { workspaceId, source: body.source } : { workspaceId, name: body.name },
      select: { id: true, enabled: true },
    });
    if (await groupNameTaken(workspaceId, body.name, existing?.id)) {
      throw new ServiceError("CONFLICT", `A different group is already named "${body.name}"`);
    }
    for (const p of body.policies) {
      await requireValid(c.req.raw, cedarId(body.name, p.name), p.policyText).catch((err) => {
        throw new ServiceError("BAD_REQUEST", `${p.name}: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
    const position = existing ? undefined : await nextGroupPosition(workspaceId);
    const group = await db.$transaction(async (tx) => {
      const g = existing
        ? await tx.cedarPolicyGroup.update({
            where: { id: existing.id },
            data: {
              name: body.name,
              description: body.description ?? null,
              enabled: body.enabled ?? existing.enabled,
              source: body.source ?? null,
              updatedByUserId: auth.userId,
            },
            select: { id: true },
          })
        : await tx.cedarPolicyGroup.create({
            data: {
              workspaceId,
              name: body.name,
              description: body.description ?? null,
              enabled: body.enabled ?? true,
              source: body.source ?? null,
              position: position ?? 0,
              updatedByUserId: auth.userId,
            },
            select: { id: true },
          });
      await tx.cedarPolicyRule.deleteMany({ where: { groupId: g.id } });
      await tx.cedarPolicyRule.createMany({
        data: body.policies.map((p, i) => ({
          workspaceId,
          groupId: g.id,
          name: p.name,
          description: p.description ?? null,
          policyText: p.policyText,
          enabled: p.enabled ?? true,
          position: i,
          updatedByUserId: auth.userId,
        })),
      });
      return tx.cedarPolicyGroup.findUniqueOrThrow({
        where: { id: g.id },
        select: {
          ...GROUP_SELECT,
          policies: { orderBy: { position: "asc" }, select: POLICY_SELECT },
        },
      });
    });
    invalidateGatewayCache(c.req.raw);
    return c.json(group, existing ? 200 : 201);
  });

  app.patch("/groups/:id", async (c) => {
    const auth = c.get("auth");
    const workspaceId = requireWorkspaceId(auth);
    await requireWorkspaceManagement(auth, workspaceId);
    const current = await findGroup(workspaceId, c.req.param("id"));
    const body = parse(groupUpdateSchema, await c.req.json().catch(() => null));
    if (body.name && body.name !== current.name && (await groupNameTaken(workspaceId, body.name, current.id))) {
      throw new ServiceError("CONFLICT", `A group named "${body.name}" already exists`);
    }
    if (body.source && (await groupSourceTaken(workspaceId, body.source, current.id))) {
      throw new ServiceError("CONFLICT", `A group with source "${body.source}" already exists`);
    }
    const row = await db.cedarPolicyGroup.update({
      where: { id: current.id },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
        ...(body.source !== undefined ? { source: body.source } : {}),
        updatedByUserId: auth.userId,
      },
      select: GROUP_SELECT,
    });
    invalidateGatewayCache(c.req.raw);
    return c.json(row);
  });

  app.delete("/groups/:id", async (c) => {
    const auth = c.get("auth");
    const workspaceId = requireWorkspaceId(auth);
    await requireWorkspaceManagement(auth, workspaceId);
    const current = await findGroup(workspaceId, c.req.param("id"));
    await db.cedarPolicyGroup.delete({ where: { id: current.id } });
    invalidateGatewayCache(c.req.raw);
    return c.body(null, 204);
  });

  // ── Policies ──────────────────────────────────────────────────────────────

  app.post("/policies", async (c) => {
    const auth = c.get("auth");
    const workspaceId = requireWorkspaceId(auth);
    await requireWorkspaceManagement(auth, workspaceId);
    const body = parse(createSchema, await c.req.json().catch(() => null));
    const group = await findGroup(workspaceId, body.groupId);
    if (await policyNameTaken(group.id, body.name)) {
      throw new ServiceError("CONFLICT", `Group "${group.name}" already has a policy named "${body.name}"`);
    }
    await requireValid(c.req.raw, cedarId(group.name, body.name), body.policyText);
    const last = await db.cedarPolicyRule.aggregate({
      where: { groupId: group.id },
      _max: { position: true },
    });
    const row = await db.cedarPolicyRule.create({
      data: {
        workspaceId,
        groupId: group.id,
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
    const group =
      body.groupId && body.groupId !== current.groupId
        ? await findGroup(workspaceId, body.groupId)
        : { id: current.groupId, name: current.group.name };
    const name = body.name ?? current.name;
    if ((name !== current.name || group.id !== current.groupId) && (await policyNameTaken(group.id, name, current.id))) {
      throw new ServiceError("CONFLICT", `Group "${group.name}" already has a policy named "${name}"`);
    }
    if (body.policyText !== undefined || name !== current.name || group.id !== current.groupId) {
      await requireValid(c.req.raw, cedarId(group.name, name), body.policyText ?? current.policyText);
    }
    const row = await db.cedarPolicyRule.update({
      where: { id: current.id },
      data: {
        ...(group.id !== current.groupId ? { groupId: group.id } : {}),
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
