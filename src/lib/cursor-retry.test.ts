import { describe, expect, it, vi } from "vitest";
import { CursorAgentError } from "@cursor/sdk";
import {
  isTransientCloudAgentFailure,
  withTransientRetries,
} from "@/lib/cursor";

describe("isTransientCloudAgentFailure", () => {
  it("matches dropped run streams", () => {
    expect(
      isTransientCloudAgentFailure(
        new Error("draft-issue agent did not finish: Run stream is no longer available"),
      ),
    ).toBe(true);
  });

  it("matches SDK retryable errors", () => {
    expect(
      isTransientCloudAgentFailure(
        new CursorAgentError("backend busy", { isRetryable: true }),
      ),
    ).toBe(true);
  });

  it("does not retry empty-result or auth-style failures", () => {
    expect(
      isTransientCloudAgentFailure(new Error("draft-issue agent returned no result text")),
    ).toBe(false);
    expect(
      isTransientCloudAgentFailure(
        new CursorAgentError("invalid api key", { isRetryable: false }),
      ),
    ).toBe(false);
  });
});

describe("withTransientRetries", () => {
  it("returns on the first success", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    await expect(withTransientRetries(fn, { sleep: async () => undefined })).resolves.toBe(
      "ok",
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries a dropped stream then succeeds", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("draft-issue agent did not finish: Run stream is no longer available"))
      .mockResolvedValueOnce("ok");
    const sleep = vi.fn(async () => undefined);

    await expect(
      withTransientRetries(fn, { label: "draft-issue", attempts: 3, delayMs: 10, sleep }),
    ).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(10);
  });

  it("does not retry a non-transient error", async () => {
    const err = new Error("draft-issue agent returned no result text");
    const fn = vi.fn().mockRejectedValue(err);
    const sleep = vi.fn(async () => undefined);

    await expect(withTransientRetries(fn, { sleep })).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("gives up after the last transient attempt", async () => {
    const err = new Error("Run stream is no longer available");
    const fn = vi.fn().mockRejectedValue(err);
    const sleep = vi.fn(async () => undefined);

    await expect(
      withTransientRetries(fn, { attempts: 3, delayMs: 5, sleep }),
    ).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });
});
