#!/usr/bin/env node
/* global console, process */

import fs from "node:fs";
import path from "node:path";

const forbiddenCredentialMarkers =
  /(?:REDACTED|REPLACE|CHANGEME|EXAMPLE|SYNTHETIC|TODO)/i;

function fail(message) {
  throw new Error(message);
}

function parseArguments(argv) {
  if (argv.length !== 2) {
    fail(
      "Usage: import-env-credentials.mjs <agent-env-file> <credential-directory>",
    );
  }

  const [envFile, credentialDirectory] = argv;
  if (!path.isAbsolute(envFile) || !path.isAbsolute(credentialDirectory)) {
    fail("Both paths must be absolute");
  }

  return { envFile, credentialDirectory };
}

function readPrivateEnvFile(envFile) {
  const stat = fs.lstatSync(envFile);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail(`Environment path is not a regular file: ${envFile}`);
  }
  if ((stat.mode & 0o777) !== 0o600) {
    fail(`Environment file must have mode 0600: ${envFile}`);
  }

  const allowedKeys = new Set(["SLACK_APP_TOKEN", "SLACK_BOT_TOKEN"]);
  const values = new Map();

  for (const rawLine of fs.readFileSync(envFile, "utf8").split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;

    const separator = line.indexOf("=");
    if (separator < 1) fail(`Malformed environment entry in ${envFile}`);

    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);
    if (!allowedKeys.has(key)) {
      fail(`Unexpected environment key in ${envFile}: ${key}`);
    }
    if (values.has(key)) fail(`Duplicate environment key in ${envFile}: ${key}`);
    values.set(key, value);
  }

  const appToken = validateToken(
    values.get("SLACK_APP_TOKEN"),
    "xapp-",
    "SLACK_APP_TOKEN",
  );
  const botToken = validateToken(
    values.get("SLACK_BOT_TOKEN"),
    "xoxb-",
    "SLACK_BOT_TOKEN",
  );

  return { appToken, botToken };
}

function validateToken(value, prefix, label) {
  if (
    typeof value !== "string" ||
    !value.startsWith(prefix) ||
    value.length < prefix.length + 16 ||
    forbiddenCredentialMarkers.test(value) ||
    /\s/u.test(value)
  ) {
    fail(`${label} has an invalid format`);
  }
  return value;
}

function ensureCredentialDirectory(credentialDirectory) {
  fs.mkdirSync(credentialDirectory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(credentialDirectory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail(`Credential directory is not a regular directory: ${credentialDirectory}`);
  }
  if (stat.uid !== 0 || stat.gid !== 0) {
    fail(`Credential directory must be owned by root: ${credentialDirectory}`);
  }
  fs.chmodSync(credentialDirectory, 0o700);
}

function installCredential(target, value) {
  if (fs.existsSync(target)) {
    const stat = fs.lstatSync(target);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.uid !== 0 ||
      stat.gid !== 0 ||
      (stat.mode & 0o777) !== 0o600
    ) {
      fail(`Existing credential has unsafe metadata: ${target}`);
    }
    if (fs.readFileSync(target, "utf8").trim() !== value) {
      fail(`Existing credential differs; refusing to overwrite: ${target}`);
    }
    return false;
  }

  fs.writeFileSync(target, `${value}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  fs.chownSync(target, 0, 0);
  fs.chmodSync(target, 0o600);
  return true;
}

function main() {
  if (process.getuid?.() !== 0) fail("Credential import must run as root");

  const { envFile, credentialDirectory } = parseArguments(process.argv.slice(2));
  const { appToken, botToken } = readPrivateEnvFile(envFile);
  ensureCredentialDirectory(credentialDirectory);

  const created = [];
  try {
    const entries = [
      ["slack_app_token", appToken],
      ["slack_bot_token", botToken],
    ];
    for (const [name, value] of entries) {
      const target = path.join(credentialDirectory, name);
      if (installCredential(target, value)) created.push(target);
    }
  } catch (error) {
    for (const target of created) fs.unlinkSync(target);
    throw error;
  }

  console.log(`Credentials ready in ${credentialDirectory}`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
