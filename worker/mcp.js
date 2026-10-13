// Minimal MCP server (Streamable HTTP transport, JSON responses, stateless) without dependencies.
// Supports initialize, ping, tools/list and tools/call — enough for Claude and other MCP clients.
import { runTool, ToolError } from "./tools.js";

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

export async function handleMcp(request, { tools, ctx, name, instructions }) {
  if (request.method === "GET" || request.method === "DELETE") {
    // No server-initiated streams and no sessions in this stateless server.
    return new Response(null, { status: 405, headers: { Allow: "POST" } });
  }
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });

  let msg;
  try { msg = JSON.parse(await request.text()); } catch { return rpc(null, null, { code: -32700, message: "Parse error" }); }
  if (Array.isArray(msg)) return rpc(null, null, { code: -32600, message: "Batching is not supported" });
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return rpc(msg?.id ?? null, null, { code: -32600, message: "Invalid Request" });

  // Notifications (no id) get 202 Accepted without a body.
  if (msg.id === undefined || msg.id === null) return new Response(null, { status: 202 });

  switch (msg.method) {
    case "initialize": {
      const asked = msg.params?.protocolVersion;
      return rpc(msg.id, {
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name, version: "1.0.0" },
        instructions,
      });
    }
    case "ping":
      return rpc(msg.id, {});
    case "tools/list":
      return rpc(msg.id, {
        tools: tools.map(t => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations })),
      });
    case "tools/call": {
      const toolName = msg.params?.name;
      if (!tools.some(t => t.name === toolName)) return rpc(msg.id, null, { code: -32602, message: `Unknown tool: ${toolName}` });
      try {
        const result = await runTool(toolName, msg.params?.arguments || {}, ctx);
        console.log(JSON.stringify({ msg: "mcp tool", server: name, tool: toolName, actor: ctx.actor || "public" }));
        return rpc(msg.id, { content: [{ type: "text", text: JSON.stringify(result, null, 1) }], structuredContent: result, isError: false });
      } catch (err) {
        if (err instanceof ToolError) return rpc(msg.id, { content: [{ type: "text", text: err.message }], isError: true });
        console.error(JSON.stringify({ msg: "mcp tool failed", tool: toolName, error: String(err) }));
        return rpc(msg.id, { content: [{ type: "text", text: "Interner Fehler beim Ausführen des Werkzeugs." }], isError: true });
      }
    }
    default:
      return rpc(msg.id, null, { code: -32601, message: `Method not found: ${msg.method}` });
  }
}

function rpc(id, result, error) {
  const body = error ? { jsonrpc: "2.0", id, error } : { jsonrpc: "2.0", id, result };
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
}
