export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

const sensitiveKey = /(?:token|secret|authorization|credential|prompt|message|content)/i;

function sanitize(value: unknown, key = ""): unknown {
  if (sensitiveKey.test(key)) return "[REDACTED]";
  if (value instanceof Error) {
    return { name: value.name, code: "INTERNAL_ERROR" };
  }
  if (Array.isArray(value)) return value.map((item) => sanitize(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [
        childKey,
        sanitize(childValue, childKey),
      ]),
    );
  }
  return value;
}

export function createLogger(
  sink: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
): Logger {
  const write = (
    level: LogLevel,
    event: string,
    fields: Record<string, unknown> = {},
  ) => {
    const safeFields = sanitize(fields) as Record<string, unknown>;
    sink(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level,
        event,
        ...safeFields,
      }),
    );
  };

  return {
    debug: (event, fields) => write("debug", event, fields),
    info: (event, fields) => write("info", event, fields),
    warn: (event, fields) => write("warn", event, fields),
    error: (event, fields) => write("error", event, fields),
  };
}
