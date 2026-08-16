export interface LogFields {
  [key: string]: string | number | boolean | null | undefined;
}

export interface Logger {
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

function write(level: "info" | "warn" | "error", event: string, fields: LogFields = {}): void {
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    service: "collaboration-service",
    event,
    ...fields,
  });
  (level === "error" ? process.stderr : process.stdout).write(`${line}\n`);
}

export const logger: Logger = {
  info: (event, fields) => write("info", event, fields),
  warn: (event, fields) => write("warn", event, fields),
  error: (event, fields) => write("error", event, fields),
};

/** third-party extension의 console.error도 JSON 계약과 본문 비노출 경계 안으로 수렴시킨다. */
export function installStructuredConsoleError(log: Logger = logger): void {
  console.error = (...values: unknown[]) => {
    const error = values.find((value): value is Error => value instanceof Error);
    log.error("collaboration_dependency_error", {
      reason: error?.name ?? "DEPENDENCY_ERROR",
    });
  };
}
