import { type Static, type TObject, type TProperties, Type } from "typebox";
import type { McpConnection, McpToolDefinition } from "../../mcp-client.ts";
import type { AgentHarnessTool } from "../types.ts";
import type { ExecutionToolContext } from "./tool-context.ts";

/**
 * Bridge an MCP server tool into the AgentHarnessTool contract.
 *
 * The MCP server's input schema (JSON Schema) is converted to a TypeBox schema
 * so the harness can validate tool arguments before calling the server. The
 * tool name is namespaced with the server name to avoid collisions across
 * multiple connected servers: `<serverName>_<toolName>`.
 */
export interface McpToolBridgeOptions {
	/** Prefix applied to tool names (defaults to the server name). */
	namePrefix?: string;
}

function jsonSchemaToTypeBox(inputSchema: Record<string, unknown> | undefined): TObject {
	if (!inputSchema || typeof inputSchema !== "object") return Type.Object({});
	const props = (inputSchema.properties as Record<string, unknown> | undefined) ?? {};
	const schemaProps: TProperties = {};
	for (const key of Object.keys(props)) {
		// Any JSON Schema property maps to a loose TypeBox schema. We only
		// validate the object shape, not per-property types, so unknown
		// schemas never throw.
		schemaProps[key] = Type.Unknown();
	}
	return Type.Object(schemaProps);
}

export function createMcpTool<TContext extends ExecutionToolContext = ExecutionToolContext>(
	connection: McpConnection,
	tool: McpToolDefinition,
	options?: McpToolBridgeOptions,
): AgentHarnessTool<TContext, TObject<TProperties>, unknown> {
	const name = `${options?.namePrefix ?? connection.server.name}_${tool.name}`;
	const schema = jsonSchemaToTypeBox(tool.inputSchema);

	return {
		name,
		label: name,
		description: tool.description ?? `MCP tool ${tool.name} from server ${connection.server.name}`,
		parameters: schema,
		async execute(_toolCallId, params, _signal, _onUpdate, _context) {
			const result = await connection.callTool(tool.name, params as Record<string, unknown>);
			if (!result.ok) {
				return {
					content: [{ type: "text", text: `MCP tool ${name} failed: ${result.error ?? "unknown error"}` }],
					details: result,
				};
			}
			const text = result.content
				.filter((part) => part.type === "text")
				.map((part) => part.text ?? "")
				.join("\n");
			return {
				content: [{ type: "text", text: text || "(no output)" }],
				details: result,
			};
		},
	};
}

/** Build harness tools for every tool exposed by a connected MCP server. */
export function createMcpTools<TContext extends ExecutionToolContext = ExecutionToolContext>(
	connection: McpConnection,
	options?: McpToolBridgeOptions,
): AgentHarnessTool<TContext, TObject<TProperties>, unknown>[] {
	return connection.tools.map((tool) => createMcpTool(connection, tool, options));
}

export type { Static };
