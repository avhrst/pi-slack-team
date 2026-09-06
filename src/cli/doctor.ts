import fs from "node:fs";
import os from "node:os";
import { spawnSync } from "node:child_process";
import type { AgentConfig } from "../config/schema.js";
import {
  loadSlackCredentials,
  resolveCredentialFiles,
} from "../config/load-config.js";
import { assertRuntimeIdentity } from "../security/runtime-identity.js";

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export function runDoctor(config: AgentConfig): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  const check = (name: string, operation: () => string) => {
    try {
      checks.push({ name, ok: true, detail: operation() });
    } catch {
      checks.push({ name, ok: false, detail: "failed" });
    }
  };

  check("runtime_identity", () => {
    assertRuntimeIdentity(config);
    return os.userInfo().username;
  });
  check("state_parent", () => {
    const parent = fs.realpathSync.native(
      fs.existsSync(config.stateDir) ? config.stateDir : os.userInfo().homedir,
    );
    return parent;
  });
  check("credentials", () => {
    const files = resolveCredentialFiles(config);
    loadSlackCredentials(config);
    return `${files.botTokenFile}, ${files.appTokenFile}`;
  });
  check("pi_version", () => {
    const result = spawnSync(config.pi.command, ["--version"], {
      cwd: config.pi.cwd,
      encoding: "utf8",
      timeout: 10_000,
    });
    if (result.status !== 0) throw new Error("Pi version check failed");
    return result.stdout.trim();
  });
  if (config.pi.transport === "tmux") check("tmux_version", () => {
    const result = spawnSync(config.pi.tmuxCommand, ["-V"], { encoding: "utf8", timeout: 10_000 });
    if (result.status !== 0 || !/^tmux (?:3\.[5-9]|[4-9]\.)/.test(result.stdout)) throw new Error("tmux 3.5+ required");
    return result.stdout.trim();
  });
  return checks;
}
