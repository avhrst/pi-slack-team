import { z } from "zod";

const absolutePath = z
  .string()
  .min(1)
  .refine((value) => value.startsWith("/"), "must be an absolute path");

const slackId = (prefix: string) =>
  z
    .string()
    .regex(new RegExp(`^${prefix}[A-Z0-9]+$`), `must start with ${prefix}`);

export const agentConfigSchema = z
  .object({
    version: z.literal(1),
    agentId: z.string().regex(/^[a-z][a-z0-9-]{1,62}$/),
    expectedUnixUser: z.string().regex(/^[a-z_][a-z0-9_-]*[$]?$/),
    stateDir: absolutePath,
    slack: z
      .object({
        teamId: slackId("T"),
        appId: slackId("A"),
        allowedUserIds: z.array(slackId("[UW]")).min(1),
        progressMode: z.enum(["summary", "raw"]).default("summary"),
      })
      .strict(),
    pi: z
      .object({
        command: absolutePath.default("/usr/bin/pi"),
        cwd: absolutePath,
        agentDir: absolutePath,
        sessionDir: absolutePath,
        maxActiveSessions: z.number().int().min(1).max(32).default(1),
        idleTimeoutMs: z.number().int().min(10_000).max(86_400_000).default(300_000),
        requestTimeoutMs: z.number().int().min(1_000).max(300_000).default(30_000),
      })
      .strict(),
    credentials: z
      .object({
        botTokenFile: absolutePath,
        appTokenFile: absolutePath,
      })
      .strict()
      .optional(),
  })
  .strict();

export type AgentConfig = z.infer<typeof agentConfigSchema>;
