import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { agentConfigSchema, type AgentConfig } from "./schema.js";

export function loadConfig(configPath: string): AgentConfig {
  const resolved = path.resolve(configPath);
  const source = fs.readFileSync(resolved, "utf8");
  const raw: unknown = parseYaml(source);
  return agentConfigSchema.parse(raw);
}

export interface SlackCredentials {
  botToken: string;
  appToken: string;
}

const forbiddenCredentialMarkers =
  /(?:REDACTED|REPLACE|CHANGEME|EXAMPLE|SYNTHETIC|TODO)/i;

function readCredential(file: string, expectedPrefix: string): string {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Credential path is not a regular file: ${file}`);
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(`Credential file permissions are too broad: ${file}`);
  }

  const value = fs.readFileSync(file, "utf8").trim();
  if (
    !value.startsWith(expectedPrefix) ||
    value.length < expectedPrefix.length + 16 ||
    forbiddenCredentialMarkers.test(value) ||
    /\s/.test(value)
  ) {
    throw new Error(`Credential in ${file} has an invalid format`);
  }
  return value;
}

export function resolveCredentialFiles(
  config: AgentConfig,
  environment: NodeJS.ProcessEnv = process.env,
): { botTokenFile: string; appTokenFile: string } {
  if (config.credentials) return config.credentials;

  const credentialsDirectory = environment.CREDENTIALS_DIRECTORY;
  if (!credentialsDirectory) {
    throw new Error(
      "No credential files configured and CREDENTIALS_DIRECTORY is unavailable",
    );
  }
  return {
    botTokenFile: path.join(credentialsDirectory, "slack_bot_token"),
    appTokenFile: path.join(credentialsDirectory, "slack_app_token"),
  };
}

export function loadSlackCredentials(
  config: AgentConfig,
  environment: NodeJS.ProcessEnv = process.env,
): SlackCredentials {
  const files = resolveCredentialFiles(config, environment);
  return {
    botToken: readCredential(files.botTokenFile, "xoxb-"),
    appToken: readCredential(files.appTokenFile, "xapp-"),
  };
}
