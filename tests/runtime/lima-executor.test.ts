import { describe, expect, it } from "vitest";
import { LimaExecutor } from "../../src/runtime/lima-executor.js";
import { LocalExecutor } from "../../src/runtime/local-executor.js";
import { executorFor } from "../../src/runtime/select.js";
import { FakeExecutor } from "../fakes/executor.js";

describe("LimaExecutor", () => {
  it("wraps the command in limactl shell with a login shell and positional arguments", async () => {
    const host = new FakeExecutor({ limactl: () => ({ stdout: "ok" }) });
    const lima = new LimaExecutor({ host, instance: "themis" });
    const result = await lima.exec({
      command: "claude",
      args: ["-p", 'it\'s "quoted" $HOME'],
      cwd: "/Users/me/themis-workspaces/app",
      env: { FOO: "a b" },
      stdin: "prompt",
      timeoutMs: 1000,
    });
    expect(result.stdout).toBe("ok");
    expect(host.requests).toEqual([
      {
        command: "limactl",
        args: [
          "shell",
          "--tty=false",
          "--workdir",
          "/Users/me/themis-workspaces/app",
          "themis",
          "--",
          "env",
          "FOO=a b",
          "bash",
          "-lc",
          'exec "$@"',
          "themis",
          "claude",
          "-p",
          'it\'s "quoted" $HOME',
        ],
        cwd: "/Users/me/themis-workspaces/app",
        timeoutMs: 1000,
        stdin: "prompt",
      },
    ]);
  });
});

describe("executorFor", () => {
  const host = new LocalExecutor();
  it("selects local, lima (with instance override) or nothing", () => {
    expect(executorFor("local", host)).toBe(host);
    expect(executorFor("lima", host)).toBeInstanceOf(LimaExecutor);
    expect(executorFor("docker", host)).toBeUndefined();
  });
});
