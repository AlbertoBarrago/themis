import {
  ExecError,
  type ExecRequest,
  type ExecResult,
  type Executor,
} from "../../src/runtime/executor.js";

type Handler = (request: ExecRequest) => Partial<ExecResult> | ExecError;

/**
 * Records every request and answers from a handler keyed by command name. Unhandled commands
 * behave as if not installed, so a test never depends on the host by accident.
 */
export class FakeExecutor implements Executor {
  readonly requests: ExecRequest[] = [];
  readonly #handlers: Record<string, Handler>;

  constructor(handlers: Record<string, Handler> = {}) {
    this.#handlers = handlers;
  }

  async exec(request: ExecRequest): Promise<ExecResult> {
    this.requests.push(request);
    const handler = this.#handlers[request.command];
    if (handler === undefined) throw new ExecError("not-found", request.command);
    const result = handler(request);
    if (result instanceof ExecError) throw result;
    return {
      exitCode: 0,
      signal: null,
      stdout: "",
      stderr: "",
      timedOut: false,
      durationMs: 1,
      ...result,
    };
  }
}
