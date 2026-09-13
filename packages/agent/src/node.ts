// Node-only modules: these import node: builtins and must stay out of the
// browser-facing root index (scripts/check-browser-smoke.mjs enforces this).
export * from "./builtin-skills.ts";
export * from "./container-runtime.ts";
export * from "./gpu-dispatcher.ts";
export { NodeExecutionEnv } from "./harness/env/nodejs.ts";
export {
	createMcpTool,
	createMcpTools,
	type McpToolBridgeOptions,
} from "./harness/tools/mcp-tools.ts";
export {
	AGENT_STATE_MB,
	CORE_PER_WAKE,
	computeMoeBudget,
	detectCpuQuota,
	detectDeviceProfile,
	detectMemLimitMB,
	MIN_RESERVE_MB,
	MIN_WAKE_SLOTS,
	type MoeAgentState,
	type MoeBudget,
	MoeBudgetExhaustedError,
	type MoeDeviceProfile,
	MoeScheduler,
	WAKE_BURST_FACTOR,
} from "./harness/tools/moe-tools.ts";
export {
	createMultiAuditTool,
	type MultiAuditPathResult,
	type MultiAuditReport,
	type MultiAuditToolInput,
} from "./harness/tools/multi-audit.ts";
export * from "./index.ts";
export * from "./isolated-executor.ts";
export * from "./load-test.ts";
export * from "./local-gpu-runtime.ts";
export {
	callMcpTool,
	connectMcpServer,
	discoverMcpServer,
	type McpClientHandle,
	type McpConnection,
	type McpServerConfig,
	type McpToolCallResult,
	type McpToolDefinition,
} from "./mcp-client.ts";
export * from "./optimize-pipeline.ts";
export * from "./remote-tunnel.ts";
export * from "./rust-bridge.ts";
export * from "./session-store.ts";
export * from "./ssh-gpu-runtime.ts";
