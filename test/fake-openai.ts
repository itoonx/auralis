// A scripted, in-process OpenAI-compatible chat-completions server for runner conformance tests.
// No network, no keys, deterministic: each POST pops the next scripted turn; every request body is
// recorded so tests can assert exactly what the model was shown (e.g. the claim-deny redirect text).
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export type ScriptedTurn =
  | { toolCalls: { name: string; args: Record<string, unknown> }[] }
  | { content: string }
  | { status: number; error: string }; // fault injection (429/500) — the runner must degrade loudly

export interface FakeOpenAI {
  url: string; // pass as baseURL
  requests: any[]; // every parsed request body, in order
  script: ScriptedTurn[]; // push more turns any time
  close(): Promise<void>;
}

export async function startFakeOpenAI(script: ScriptedTurn[] = []): Promise<FakeOpenAI> {
  const requests: any[] = [];
  const state = { script: [...script] };
  let calls = 0;
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = body ? JSON.parse(body) : {};
      requests.push(parsed);
      const turn = state.script.shift();
      if (!turn) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "fake-openai: script exhausted" } }));
        return;
      }
      if ("status" in turn) {
        res.writeHead(turn.status, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: turn.error } }));
        return;
      }
      const message =
        "toolCalls" in turn
          ? {
              role: "assistant",
              content: null,
              tool_calls: turn.toolCalls.map((t, i) => ({
                id: `call_${calls}_${i}`,
                type: "function",
                function: { name: t.name, arguments: JSON.stringify(t.args) },
              })),
            }
          : { role: "assistant", content: turn.content };
      calls++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: `chatcmpl-fake-${calls}`,
          object: "chat.completion",
          model: parsed.model ?? "fake",
          choices: [{ index: 0, message, finish_reason: "toolCalls" in turn ? "tool_calls" : "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    script: state.script,
    close: () => new Promise((r) => server.close(() => r())),
  };
}
