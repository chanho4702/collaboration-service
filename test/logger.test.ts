import { afterEach, describe, expect, it, vi } from "vitest";
import { installStructuredConsoleError, type Logger } from "../src/logger.js";

const originalConsoleError = console.error;

afterEach(() => {
  console.error = originalConsoleError;
});

describe("structured dependency logging", () => {
  it("의존성 console.error에서 문서명·본문을 버리고 오류 종류만 JSON logger로 보낸다", () => {
    const log: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    installStructuredConsoleError(log);

    console.error("Redis publish page:7 secret-body", new TypeError("secret-body"));

    expect(log.error).toHaveBeenCalledWith("collaboration_dependency_error", {
      reason: "TypeError",
    });
    expect(JSON.stringify(vi.mocked(log.error).mock.calls)).not.toContain("secret-body");
    expect(JSON.stringify(vi.mocked(log.error).mock.calls)).not.toContain("page:7");
  });
});
