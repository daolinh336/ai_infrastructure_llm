import { describe, it, expect, vi } from "vitest";
import { withRetry, DockerTimeoutError, DockerConnectionError, DockerPermissionError } from "../src/docker.js";

describe("withRetry", () => {
  it("returns result on first attempt (no retry needed)", async () => {
    const fn = vi.fn().mockResolvedValue("success");
    const result = await withRetry(fn, { maxRetries: 3, baseDelayMs: 10 });
    expect(result).toBe("success");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on transient ECONNRESET error", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("read ECONNRESET"))
      .mockResolvedValue("recovered");
    const result = await withRetry(fn, { maxRetries: 3, baseDelayMs: 10, label: "test" });
    expect(result).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("retries on timeout error", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new DockerTimeoutError("timed out"))
      .mockResolvedValue("recovered");
    const result = await withRetry(fn, { maxRetries: 3, baseDelayMs: 10 });
    expect(result).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry on 404 Not Found", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("HTTP 404: Not Found"));
    await expect(withRetry(fn, { maxRetries: 3, baseDelayMs: 10 }))
      .rejects.toThrow("HTTP 404: Not Found");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry on permission denied", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("Permission denied"));
    await expect(withRetry(fn, { maxRetries: 3, baseDelayMs: 10 }))
      .rejects.toThrow("Permission denied");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry on DockerConnectionError", async () => {
    const fn = vi.fn().mockRejectedValue(new DockerConnectionError("cannot connect"));
    await expect(withRetry(fn, { maxRetries: 3, baseDelayMs: 10 }))
      .rejects.toThrow("cannot connect");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry on DockerPermissionError", async () => {
    const fn = vi.fn().mockRejectedValue(new DockerPermissionError("access denied"));
    await expect(withRetry(fn, { maxRetries: 3, baseDelayMs: 10 }))
      .rejects.toThrow("access denied");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on 500 Internal Server Error", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("HTTP 500: Internal Server Error"))
      .mockResolvedValue("recovered");
    const result = await withRetry(fn, { maxRetries: 3, baseDelayMs: 10 });
    expect(result).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("exhausts retries and throws last error", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("read ECONNRESET"));
    await expect(withRetry(fn, { maxRetries: 2, baseDelayMs: 10 }))
      .rejects.toThrow("read ECONNRESET");
    expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it("retries on socket hang up", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockResolvedValue("ok");
    const result = await withRetry(fn, { maxRetries: 3, baseDelayMs: 10 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
