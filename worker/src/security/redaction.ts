const sensitiveKey =
  /authorization|cookie|token|secret|password|code|verifier/iu;

export function sanitizedMessage(error: unknown): string {
  if (error instanceof Error) {
    if (sensitiveKey.test(error.message)) return "Sensitive operation failed";
    return error.message.slice(0, 240);
  }
  return "Unexpected operation failure";
}

export function safeLog(
  level: "info" | "warn" | "error",
  event: string,
  values: Record<string, string | number | boolean | undefined> = {},
): void {
  const sanitized = Object.fromEntries(
    Object.entries(values)
      .filter(([key]) => !sensitiveKey.test(key))
      .map(([key, value]) => [
        key,
        typeof value === "string" ? value.slice(0, 160) : value,
      ]),
  );
  console[level](JSON.stringify({ level, event, ...sanitized }));
}
