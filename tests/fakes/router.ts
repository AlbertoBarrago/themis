import type { ExecRequest, ExecResult, Executor } from "../../src/runtime/executor.js";
import { LocalExecutor } from "../../src/runtime/local-executor.js";
import { FakeExecutor } from "./executor.js";

type Handler = ConstructorParameters<typeof FakeExecutor>[0];

/** Runs real `git` on the host and answers every other command from fake handlers. */
export class GitRouter implements Executor {
  readonly local = new LocalExecutor();
  readonly fake: FakeExecutor;

  constructor(handlers: Handler) {
    this.fake = new FakeExecutor(handlers);
  }

  exec(request: ExecRequest): Promise<ExecResult> {
    return request.command === "git" ? this.local.exec(request) : this.fake.exec(request);
  }
}
