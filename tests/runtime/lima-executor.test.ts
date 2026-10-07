import { describe, expect, it } from "vitest";
import { ExecError, type ExecResult } from "../../src/runtime/executor.js";
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

describe("LimaExecutor.check", () => {
  type Reply = Partial<ExecResult> | ExecError;
  /** Host answering `limactl list` and `limactl shell` separately. */
  function check(list: Reply, shell: Reply = { stdout: "" }) {
    const host = new FakeExecutor({
      limactl: (req) => (req.args[0] === "list" ? list : shell),
    });
    return new LimaExecutor({ host, instance: "themis" }).check("/w/app");
  }

  it("passes when the VM is running and answers", async () => {
    expect(await check({ stdout: "Running\n" })).toBeUndefined();
  });

  it("explains how to start a stopped VM", async () => {
    expect(await check({ stdout: "Stopped\n" })).toBe(
      'Lima VM "themis" is stopped: start it with limactl start themis',
    );
  });

  it("explains how to create a missing VM", async () => {
    expect(await check({ exitCode: 1, stderr: 'level=fatal msg="unmatched instances"' })).toBe(
      'Lima VM "themis" does not exist: create it with scripts/lima/create-vm.sh, or name another instance with THEMIS_LIMA_INSTANCE',
    );
  });

  it("reports a running VM that refuses SSH, with the last line of the error", async () => {
    expect(
      await check(
        { stdout: "Running\n" },
        {
          exitCode: 255,
          stderr: "ssh: connect to host 127.0.0.1 port 58153: Connection refused\n",
        },
      ),
    ).toBe(
      'Lima VM "themis" is running but does not answer (still booting?): retry in a moment, or restart it with limactl stop themis && limactl start themis (ssh: connect to host 127.0.0.1 port 58153: Connection refused)',
    );
  });

  it("reports a probe that times out", async () => {
    expect(await check({ stdout: "Running\n" }, { exitCode: null, timedOut: true })).toContain(
      "(no answer within 30s)",
    );
  });

  it("explains how to install Lima when limactl is missing", async () => {
    expect(await check(new ExecError("not-found", "limactl"))).toBe(
      "limactl is not installed: install Lima (https://lima-vm.io), then create the VM with scripts/lima/create-vm.sh",
    );
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
