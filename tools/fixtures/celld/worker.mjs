import {WorkflowEntrypoint} from "cloudflare:workers";
import {runPatternWorkflow, patternWorkflowId} from "./pattern-workflow.mjs";

export class PatternWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const {runId} = event.payload;
    let sequence = 0;
    let stepId;
    const request = async (operation, payload) => {
      const response = await fetch(this.env.GATEWAY, {
        method: "POST",
        headers: {"content-type": "application/json"},
        body: JSON.stringify({runId, stepId, operation, ...payload}),
      });
      if (!response.ok) throw new Error(`gateway: ${response.status}`);
      return response.json();
    };
    const wf = {
      id: patternWorkflowId(runId),
      signal: new AbortController().signal,
      step: (name, perform) => {
        const id = `${++sequence}-${name}`;
        return step.do(id, async () => {
          stepId = id;
          return perform();
        });
      },
      recv: async (topic) => {
        const message = await step.waitForEvent(`${++sequence}-event`, {type: topic, timeout: "10 minutes"});
        return message.payload;
      },
    };
    return runPatternWorkflow(wf, {}, {
      enterEntry: () => request("entry"),
      leave: (_runId, message) => request("leave", {message}),
      enterNext: (_runId, left) => request("enter", {left}),
    });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const id = url.searchParams.get("id");
    if (request.method === "POST" && url.pathname === "/create") {
      const params = await request.json();
      const run = await env.PATTERNS.create({id: params.runId, params});
      return Response.json({id: run.id}, {status: 201});
    }
    if (request.method === "POST" && url.pathname === "/event" && id) {
      const instance = await env.PATTERNS.get(id);
      await instance.sendEvent({type: "advance", payload: await request.json()});
      return new Response(null, {status: 204});
    }
    if (request.method === "GET" && url.pathname === "/status" && id) {
      const instance = await env.PATTERNS.get(id);
      return Response.json(await instance.status());
    }
    return new Response(null, {status: 204});
  },
};
