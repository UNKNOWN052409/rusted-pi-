/**
 * Huge-prompt chunking — no prompt-size limit.
 *
 * A very large prompt (e.g. 1 lakh lines) is split into chunks (default 20%
 * of the total line count, capped at a configurable max), each chunk is
 * summarized/read (optionally by parallel readers), and the summaries are
 * merged into a single compact understanding the agent can act on.
 */

export interface ChunkPromptOptions {
	/** Fraction of the prompt per chunk (default 0.2 = 20%). */
	chunkFraction?: number;
	/** Hard cap on lines per chunk (default 20_000). */
	maxChunkLines?: number;
	/** Number of parallel readers (default 4). */
	parallelism?: number;
	/** Summarizer: given a chunk, return its understanding (default: identity). */
	summarize?: (chunk: string, index: number, total: number) => Promise<string>;
}

export interface ChunkResult {
	/** Individual chunk summaries, in order. */
	chunks: string[];
	/** Merged summary of the whole prompt. */
	merged: string;
	/** Total line count of the original prompt. */
	totalLines: number;
	/** Number of chunks produced. */
	chunkCount: number;
}

/** Split text into chunks of at most maxLines lines each. */
export function splitIntoChunks(text: string, maxLines: number): string[] {
	const lines = text.split("\n");
	const chunks: string[] = [];
	for (let i = 0; i < lines.length; i += maxLines) {
		chunks.push(lines.slice(i, i + maxLines).join("\n"));
	}
	return chunks;
}

/** Compute the per-chunk line cap for a prompt of totalLines lines. */
export function chunkLineCap(totalLines: number, options: ChunkPromptOptions = {}): number {
	const fraction = options.chunkFraction ?? 0.2;
	const maxChunk = options.maxChunkLines ?? 20_000;
	const byFraction = Math.max(1, Math.floor(totalLines * fraction));
	return Math.min(maxChunk, byFraction);
}

/**
 * Process a huge prompt: chunk it, summarize each chunk (in parallel up to the
 * configured parallelism), and merge into one understanding.
 */
export async function chunkAndUnderstand(text: string, options: ChunkPromptOptions = {}): Promise<ChunkResult> {
	const totalLines = text.split("\n").length;
	const cap = chunkLineCap(totalLines, options);
	const chunks = splitIntoChunks(text, cap);
	const summarize = options.summarize ?? (async (chunk) => chunk);
	const parallelism = Math.max(1, options.parallelism ?? 4);

	// Process chunks in waves of `parallelism`.
	const summaries: string[] = new Array(chunks.length);
	let cursor = 0;
	const worker = async (): Promise<void> => {
		for (;;) {
			const index = cursor++;
			if (index >= chunks.length) return;
			summaries[index] = await summarize(chunks[index], index, chunks.length);
		}
	};
	await Promise.all(Array.from({ length: Math.min(parallelism, chunks.length) }, () => worker()));

	const merged = summaries.map((s, i) => `--- chunk ${i + 1}/${chunks.length} ---\n${s}`).join("\n\n");

	return { chunks: summaries, merged, totalLines, chunkCount: chunks.length };
}
