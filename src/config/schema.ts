import { z } from "zod";

const absolutePath = z
  .string()
  .min(1)
  .refine((value) => value.startsWith("/"), "must be an absolute path");

const slackId = (prefix: string) =>
  z
    .string()
    .regex(new RegExp(`^${prefix}[A-Z0-9]+$`), `must start with ${prefix}`);

const autoSelectRuleSchema = z
  .object({
    title: z.string().min(1).max(500),
    option: z.string().min(1).max(1_000),
  })
  .strict();

const autoSelectSchema = z
  .array(autoSelectRuleSchema)
  .max(16)
  .superRefine((rules, context) => {
    const titles = new Set<string>();
    for (const [index, rule] of rules.entries()) {
      if (titles.has(rule.title)) {
        context.addIssue({
          code: "custom",
          path: [index, "title"],
          message: "automatic select titles must be unique",
        });
      }
      titles.add(rule.title);
    }
  })
  .default([]);

const interAgentPeerSchema = z
  .object({
    agentId: z.string().regex(/^[a-z][a-z0-9-]{1,62}$/),
    role: z.enum(["worker", "manager"]),
    appId: slackId("A"),
    botUserId: slackId("[UW]"),
  })
  .strict();

export const agentConfigSchema = z
  .object({
    version: z.literal(1),
    agentId: z.string().regex(/^[a-z][a-z0-9-]{1,62}$/),
    role: z.enum(["worker", "manager"]).default("worker"),
    expectedUnixUser: z.string().regex(/^[a-z_][a-z0-9_-]*[$]?$/),
    stateDir: absolutePath,
    slack: z
      .object({
        teamId: slackId("T"),
        appId: slackId("A"),
        allowedUserIds: z.array(slackId("[UW]")).min(1),
        progressMode: z.enum(["summary", "raw"]).default("summary"),
        fileUploads: z.boolean().default(false),
        maxFileBytes: z
          .number()
          .int()
          .min(1_024)
          .max(100 * 1_024 * 1_024)
          .default(20 * 1_024 * 1_024),
        maxFilesPerMessage: z.number().int().min(1).max(10).default(5),
      })
      .strict(),
    pi: z
      .object({
        command: absolutePath.default("/usr/bin/pi"),
        cwd: absolutePath,
        agentDir: absolutePath,
        sessionDir: absolutePath,
        maxActiveSessions: z.number().int().min(1).max(32).optional(),
        maxConcurrentTurns: z.number().int().min(1).max(32).optional(),
        maxResidentProcesses: z.number().int().min(1).max(32).default(8),
        idleTimeoutMs: z.number().int().min(10_000).max(86_400_000).default(300_000),
        requestTimeoutMs: z.number().int().min(1_000).max(300_000).default(30_000),
        autoSelect: autoSelectSchema,
      })
      .strict()
      .transform((pi) => ({
        ...pi,
        maxConcurrentTurns:
          pi.maxConcurrentTurns ?? pi.maxActiveSessions ?? 4,
      })),
    interAgent: z
      .object({
        peers: z.array(interAgentPeerSchema).min(1).max(32),
        requestTimeoutMs: z
          .number()
          .int()
          .min(10_000)
          .max(3_600_000)
          .default(900_000),
        maxTaskChars: z.number().int().min(1_000).max(37_000).default(30_000),
        maxResponseChars: z
          .number()
          .int()
          .min(1_000)
          .max(100_000)
          .default(50_000),
      })
      .strict()
      .optional(),
    credentials: z
      .object({
        botTokenFile: absolutePath,
        appTokenFile: absolutePath,
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((config, context) => {
    const concurrentTurns =
      config.pi.maxConcurrentTurns ?? config.pi.maxActiveSessions ?? 4;
    if (config.pi.maxResidentProcesses < concurrentTurns) {
      context.addIssue({
        code: "custom",
        path: ["pi", "maxResidentProcesses"],
        message: "must be greater than or equal to the concurrent turn limit",
      });
    }
    const peers = config.interAgent?.peers ?? [];
    const seenAgentIds = new Set<string>();
    const seenAppIds = new Set<string>();
    const seenBotUserIds = new Set<string>();
    for (const [index, peer] of peers.entries()) {
      if (peer.role === config.role) {
        context.addIssue({
          code: "custom",
          path: ["interAgent", "peers", index, "role"],
          message: `${config.role} runtimes may trust only ${config.role === "manager" ? "worker" : "manager"} peers`,
        });
      }
      for (const [value, seen, field] of [
        [peer.agentId, seenAgentIds, "agentId"],
        [peer.appId, seenAppIds, "appId"],
        [peer.botUserId, seenBotUserIds, "botUserId"],
      ] as const) {
        if (seen.has(value)) {
          context.addIssue({
            code: "custom",
            path: ["interAgent", "peers", index, field],
            message: `duplicate inter-agent ${field}`,
          });
        }
        seen.add(value);
      }
      if (peer.appId === config.slack.appId) {
        context.addIssue({
          code: "custom",
          path: ["interAgent", "peers", index, "appId"],
          message: "an inter-agent peer cannot use this runtime's Slack app",
        });
      }
    }
  });

export type AgentConfig = z.infer<typeof agentConfigSchema>;
