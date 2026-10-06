import {
  type AgentInvocation,
  type AgentResult,
  type AgentRunner,
  NO_USAGE,
} from "../../src/adapters/agent-runner.js";

type Reply = AgentResult | ((invocation: AgentInvocation) => AgentResult);

/** Replays scripted results in order and records every invocation. */
export class FakeAgentRunner implements AgentRunner {
  readonly agent = "fake";
  readonly invocations: AgentInvocation[] = [];
  readonly #replies: Reply[];

  constructor(replies: Reply[]) {
    this.#replies = [...replies];
  }

  async run(invocation: AgentInvocation): Promise<AgentResult> {
    this.invocations.push(invocation);
    const reply = this.#replies.shift();
    if (reply === undefined) throw new Error("FakeAgentRunner: no scripted reply left");
    return typeof reply === "function" ? reply(invocation) : reply;
  }
}

/** A successful structured reply. */
export function structured(value: unknown, costUsd = 0.01): AgentResult {
  return {
    ok: true,
    text: JSON.stringify(value),
    structured: value,
    usage: { ...NO_USAGE, inputTokens: 100, outputTokens: 50, costUsd },
    durationMs: 1000,
    permissionDenials: 0,
  };
}
