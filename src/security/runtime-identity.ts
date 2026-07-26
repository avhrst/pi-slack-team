import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentConfig } from "../config/schema.js";

function inside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function assertRuntimeIdentity(config: AgentConfig): void {
  const user = os.userInfo();
  if (user.uid === 0 || user.username === "root") {
    throw new Error("pi-slack-team must not run as root");
  }
  if (user.username !== config.expectedUnixUser) {
    throw new Error("Effective Unix user does not match expectedUnixUser");
  }
  if (!inside(user.homedir, config.stateDir)) {
    throw new Error("stateDir must be inside the effective user's home");
  }
  if (!inside(user.homedir, config.pi.agentDir)) {
    throw new Error("pi.agentDir must be inside the effective user's home");
  }
  if (!inside(config.pi.agentDir, config.pi.sessionDir)) {
    throw new Error("pi.sessionDir must be inside pi.agentDir");
  }
  if (!fs.statSync(config.pi.cwd).isDirectory()) {
    throw new Error("pi.cwd is not a directory");
  }
  fs.accessSync(config.pi.command, fs.constants.X_OK);
}
