/* eslint-disable */

export interface GpuInfo {
	available: boolean;
	name: string;
	vramMb: number;
	computeCapability: number;
	smCount: number;
	isWddm: boolean;
}

export interface CpuLoad {
	load: number;
	coreCount: number;
	shouldYield: boolean;
}

export interface SystemMemory {
	totalMb: number;
}

export interface StabilityCheckResult {
	pass: boolean;
	issues: Array<{
		type: string;
		severity: string;
		detail: string;
		pattern?: string;
	}>;
	suggestedAction: string;
	source: string;
}

export interface ApiDetectionResult {
	/** Detected API format */
	api: string;
	/** Confidence score 0-1 */
	confidence: number;
	/** Display name for the provider */
	providerName: string;
	/** Whether this is a well-known provider */
	isKnownProvider: boolean;
}

export interface WebSearchResult {
	success: boolean;
	query: string;
	results: Array<{ title: string; url: string }>;
	resultCount: number;
}

export interface FetchUrlResult {
	success: boolean;
	text?: string;
	status?: number;
	error?: string;
	length?: number;
}

export function detectGpu(): Promise<GpuInfo>;
export function cpuLoad(threshold?: number): Promise<CpuLoad>;
export function systemMemoryMb(): Promise<number>;
export function checkStabilityRust(text: string, opts?: { modelId?: string }): Promise<StabilityCheckResult>;
export function detectApiFromUrlRust(url: string): Promise<ApiDetectionResult>;
export function searchWebRust(query: string): Promise<WebSearchResult>;
export function fetchUrlRust(url: string): Promise<FetchUrlResult>;
export function shutdown(): void;
