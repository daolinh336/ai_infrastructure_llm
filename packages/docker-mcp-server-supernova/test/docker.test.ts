import { describe, it, expect } from "vitest";
import {
  formatContainer,
  formatError,
  formatBytes,
  formatImage,
  sanitizeOutput,
  DockerConnectionError,
  DockerTimeoutError,
  DockerPermissionError,
} from "../src/docker.js";

describe("formatContainer", () => {
  const baseContainer = {
    Id: "abcdef1234567890",
    Names: ["/my-container"],
    Image: "nginx:latest",
    State: "running",
    Status: "Up 2 hours",
    Created: Math.floor(Date.now() / 1000) - 7200,
    Ports: [
      { PrivatePort: 80, PublicPort: 8080, Type: "tcp" },
      { PrivatePort: 443, PublicPort: 0, Type: "tcp" },
    ],
    Labels: { "com.docker.compose.project": "web" },
    Mounts: [
      {
        Type: "volume",
        Source: "my-vol",
        Destination: "/data",
        Mode: "rw",
        RW: true,
      },
    ],
  } as any;

  it("truncates container ID to 12 chars", () => {
    const result = formatContainer(baseContainer);
    expect(result.id).toBe("abcdef123456");
  });

  it("strips leading slash from name", () => {
    const result = formatContainer(baseContainer);
    expect(result.name).toBe("my-container");
  });

  it("includes image, state, status", () => {
    const result = formatContainer(baseContainer);
    expect(result.image).toBe("nginx:latest");
    expect(result.state).toBe("running");
    expect(result.status).toBe("Up 2 hours");
  });

  it("formats created as ISO string", () => {
    const result = formatContainer(baseContainer);
    expect(new Date(result.created as string).toISOString()).toBe(result.created);
  });

  it("maps ports correctly", () => {
    const result = formatContainer(baseContainer);
    expect(result.ports).toEqual([
      { private: 80, public: 8080, type: "tcp" },
      { private: 443, public: 0, type: "tcp" },
    ]);
  });

  it("maps mounts correctly", () => {
    const result = formatContainer(baseContainer);
    expect(result.mounts).toEqual([
      {
        type: "volume",
        source: "my-vol",
        destination: "/data",
        mode: "rw",
        rw: true,
      },
    ]);
  });

  it("handles empty names array", () => {
    const container = { ...baseContainer, Names: [] };
    const result = formatContainer(container);
    expect(result.name).toBeUndefined();
  });

  it("handles empty ports and mounts", () => {
    const container = { ...baseContainer, Ports: [], Mounts: [] };
    const result = formatContainer(container);
    expect(result.ports).toEqual([]);
    expect(result.mounts).toEqual([]);
  });
});

describe("formatImage", () => {
  const baseImage = {
    Id: "sha256:abcdef1234567890abcdef1234567890",
    RepoTags: ["nginx:latest", "nginx:1.25"],
    Size: 187_000_000,
    Created: "2024-01-15T10:30:00Z",
  } as any;

  it("truncates image ID to 19 chars", () => {
    const result = formatImage(baseImage);
    expect(result.id).toBe("sha256:abcdef123456");
  });

  it("includes tags, size, created", () => {
    const result = formatImage(baseImage);
    expect(result.tags).toEqual(["nginx:latest", "nginx:1.25"]);
    expect(result.size).toBe(187_000_000);
  });

  it("handles null RepoTags", () => {
    const image = { ...baseImage, RepoTags: null };
    const result = formatImage(image);
    expect(result.tags).toEqual(["<none>:<none>"]);
  });
});

describe("formatError", () => {
  it("formats DockerConnectionError", () => {
    const err = new DockerConnectionError("socket not found");
    expect(formatError(err)).toBe("DockerConnectionError: socket not found");
  });

  it("formats DockerTimeoutError", () => {
    const err = new DockerTimeoutError("timed out after 5000ms");
    expect(formatError(err)).toBe("DockerTimeoutError: timed out after 5000ms");
  });

  it("formats DockerPermissionError", () => {
    const err = new DockerPermissionError("access denied");
    expect(formatError(err)).toBe("DockerPermissionError: access denied");
  });

  it("formats generic Error", () => {
    const err = new Error("something broke");
    expect(formatError(err)).toBe("something broke");
  });

  it("formats string errors", () => {
    expect(formatError("raw string error")).toBe("raw string error");
  });

  it("formats unknown types", () => {
    expect(formatError(42)).toBe("42");
    expect(formatError(null)).toBe("null");
    expect(formatError(undefined)).toBe("undefined");
  });
});

describe("formatBytes", () => {
  it("formats 0 bytes", () => {
    expect(formatBytes(0)).toBe("0 B");
  });

  it("formats bytes", () => {
    expect(formatBytes(512)).toBe("512 B");
  });

  it("formats kilobytes", () => {
    expect(formatBytes(1024)).toBe("1 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
  });

  it("formats megabytes", () => {
    expect(formatBytes(1_048_576)).toBe("1 MB");
  });

  it("formats gigabytes", () => {
    expect(formatBytes(1_073_741_824)).toBe("1 GB");
  });

  it("formats terabytes", () => {
    expect(formatBytes(1_099_511_627_776)).toBe("1 TB");
  });
});

describe("sanitizeOutput", () => {
  it("strips ANSI escape codes", () => {
    const input = "\x1b[31mred text\x1b[0m";
    expect(sanitizeOutput(input)).toBe("red text");
  });

  it("strips OSC sequences", () => {
    const input = "\x1b]0;title\x07visible";
    expect(sanitizeOutput(input)).toBe("visible");
  });

  it("strips invisible Unicode characters", () => {
    const input = "before\u200Bafter\uFEFFend";
    expect(sanitizeOutput(input)).toBe("beforeafterend");
  });

  it("truncates long output", () => {
    const long = "a".repeat(2_000_000);
    const result = sanitizeOutput(long, 1_000_000);
    expect(result.length).toBeLessThan(2_000_000);
    expect(result).toContain("[output truncated at 1000000 chars]");
  });

  it("preserves short output", () => {
    const short = "hello world";
    expect(sanitizeOutput(short)).toBe("hello world");
  });

  it("handles empty string", () => {
    expect(sanitizeOutput("")).toBe("");
  });
});
