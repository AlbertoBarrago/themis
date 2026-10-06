import { describe, expect, it } from "vitest";
import { ExecError } from "../../src/runtime/executor.js";
import { LocalExecutor } from "../../src/runtime/local-executor.js";

const executor = new LocalExecutor({ killGraceMs: 100 });
const node = process.execPath;

describe("LocalExecutor", () => {
  it("captures stdout, stderr and exit code without a shell", async () => {
    const result = await executor.exec({
      command: node,
      args: ["-e", "console.log('out $HOME'); console.error('err'); process.exit(3)"],
      cwd: process.cwd(),
    });
    expect(result).toMatchObject({
      exitCode: 3,
      signal: null,
      stdout: "out $HOME\n",
      stderr: "err\n",
      timedOut: false,
    });
  });

  it("passes stdin, cwd and env overrides", async () => {
    const result = await executor.exec({
      command: node,
      args: [
        "-e",
        "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(s, process.env.ORDITO_X, process.cwd()))",
      ],
      cwd: "/",
      env: { ORDITO_X: "y" },
      stdin: "hello",
    });
    expect(result.stdout).toBe("hello y /\n");
  });

  it("kills a command that exceeds its timeout", async () => {
    const result = await executor.exec({
      command: node,
      args: ["-e", "setTimeout(() => {}, 10000)"],
      cwd: process.cwd(),
      timeoutMs: 100,
    });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(result.signal).toBe("SIGTERM");
  });

  it("rejects with a not-found ExecError for a missing command", async () => {
    await expect(
      executor.exec({ command: "ordito-definitely-missing", args: [], cwd: process.cwd() }),
    ).rejects.toMatchObject({ name: "ExecError", kind: "not-found" });
    await expect(
      executor.exec({ command: "ordito-definitely-missing", args: [], cwd: process.cwd() }),
    ).rejects.toBeInstanceOf(ExecError);
  });

  it("keeps only the tail of oversized output", async () => {
    const small = new LocalExecutor({ maxOutputBytes: 1000 });
    const result = await small.exec({
      command: node,
      args: ["-e", "for (let i = 0; i < 2000; i++) console.log(i)"],
      cwd: process.cwd(),
    });
    expect(result.stdout.length).toBeLessThanOrEqual(1000);
    expect(result.stdout.endsWith("1999\n")).toBe(true);
  });
});
