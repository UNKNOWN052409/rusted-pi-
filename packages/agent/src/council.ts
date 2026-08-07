/**
 * Council — a Karpathy-style "LLM council" for pressure-testing decisions.
 *
 * Runs a question through a panel of independent advisors, has them review
 * each other anonymously, and synthesizes a final verdict. Inspired by the
 * premium "council" features found in jcode / oh-my-pi style agents, but
 * dependency-free: the actual advisor reasoning is pluggable (an LLM call,
 * a local model, a subagent, or a plain function).
 */

/** One advisor in the council. */
export interface CouncilAdvisor {
	/** Stable name, e.g. "security", "architecture", "ux". */
	name: string;
	/** One-line persona description shown to the advisor. */
	persona: string;
	/** Produce an independent written opinion for a question. */
	opine(question: string, context: string): Promise<CouncilOpinion> | CouncilOpinion;
}

/** An individual advisor's written opinion. */
export interface CouncilOpinion {
	/** Short title of the opinion. */
	title: string;
	/** The advisor's reasoning. */
	reasoning: string;
	/** Position: agree / disagree / mixed with the proposal. */
	stance: "agree" | "disagree" | "mixed";
	/** 0-10 confidence in the opinion. */
	confidence: number;
}

/** A peer review of one advisor's opinion by another (anonymized). */
export interface CouncilReview {
	/** Which advisor produced this review. */
	reviewer: string;
	/** Which opinion is being reviewed (by advisor name). */
	target: string;
	/** 0-10 quality score. */
	score: number;
	/** Short critique. */
	critique: string;
}

/** Final synthesized verdict. */
export interface CouncilVerdict {
	/** The synthesized recommendation. */
	summary: string;
	/** Overall confidence 0-10. */
	confidence: number;
	/** Number of advisors consulted. */
	advisors: number;
	/** Average peer-review score across opinions. */
	avgReviewScore: number;
	/** The strongest concern raised by any reviewer. */
	topConcern?: string;
}

/** Options for running a council. */
export interface CouncilOptions {
	/** Panel of advisors. Defaults to a built-in 5-advisor panel. */
	advisors?: CouncilAdvisor[];
	/** When true, run all advisors in parallel. Default true. */
	parallel?: boolean;
	/** When true, include peer review between advisors. Default true. */
	peerReview?: boolean;
}

const DEFAULT_PANEL: CouncilAdvisor[] = [
	{
		name: "skeptic",
		persona: "Adversarial skeptic. Find every hole in the proposal.",
		opine: (question) => ({
			title: "Adversarial read",
			reasoning: `The skeptic challenges the premise behind: ${question}. What could go wrong, what is assumed, and what breaks first?`,
			stance: "mixed",
			confidence: 6,
		}),
	},
	{
		name: "architect",
		persona: "Systems architect. Focus on structure, dependencies and failure modes.",
		opine: (question) => ({
			title: "Structural view",
			reasoning: `The architect maps the moving parts for: ${question}. Where do boundaries, state and failure modes live?`,
			stance: "agree",
			confidence: 7,
		}),
	},
	{
		name: "user",
		persona: "End-user advocate. Focus on experience, clarity and cost to the user.",
		opine: (question) => ({
			title: "User impact",
			reasoning: `The user advocate asks how ${question} feels to the person paying for it, and whether it is simpler than the alternative.`,
			stance: "mixed",
			confidence: 5,
		}),
	},
	{
		name: "security",
		persona: "Security engineer. Hunt for trust boundaries and unsafe defaults.",
		opine: (question) => ({
			title: "Security pass",
			reasoning: `The security engineer audits ${question} for trust boundaries, injection surface and unsafe defaults.`,
			stance: "disagree",
			confidence: 6,
		}),
	},
	{
		name: "pragmatist",
		persona: "Pragmatic builder. Focus on shipping the narrowest viable version.",
		opine: (question) => ({
			title: "Shipping view",
			reasoning: `The pragmatist finds the narrowest wedge that delivers ${question} today, without gold-plating.`,
			stance: "agree",
			confidence: 7,
		}),
	},
];

/** Run the council. Returns per-advisor opinions, peer reviews, and a verdict. */
export async function runCouncil(
	question: string,
	options: CouncilOptions = {},
	context = "",
): Promise<{
	opinions: Array<{ advisor: string; opinion: CouncilOpinion }>;
	reviews: CouncilReview[];
	verdict: CouncilVerdict;
}> {
	const panel = options.advisors ?? DEFAULT_PANEL;
	const parallel = options.parallel ?? true;
	const peerReview = options.peerReview ?? true;

	const run = async (advisor: CouncilAdvisor): Promise<{ advisor: string; opinion: CouncilOpinion }> => {
		const opinion = await advisor.opine(question, context);
		return { advisor: advisor.name, opinion };
	};

	const results = parallel
		? await Promise.all(panel.map((advisor) => run(advisor)))
		: await (async () => {
				const out: Array<{ advisor: string; opinion: CouncilOpinion }> = [];
				for (const advisor of panel) {
					out.push(await run(advisor));
				}
				return out;
			})();

	const reviews: CouncilReview[] = [];
	if (peerReview && results.length > 1) {
		for (const target of results) {
			const reviewers = results.filter((r) => r.advisor !== target.advisor);
			for (const reviewer of reviewers) {
				reviews.push({
					reviewer: reviewer.advisor,
					target: target.advisor,
					score: Math.max(1, Math.min(10, Math.round(reviewer.opinion.confidence * 0.7 + 2))),
					critique: `${reviewer.opinion.title} weighs in on "${target.opinion.title}": ${reviewer.opinion.stance}.`,
				});
			}
		}
	}

	const avgReviewScore =
		reviews.length === 0
			? results.reduce((sum, r) => sum + r.opinion.confidence, 0) / Math.max(1, results.length)
			: reviews.reduce((sum, r) => sum + r.score, 0) / reviews.length;

	const agreements = results.filter((r) => r.opinion.stance === "agree").length;
	const disagreements = results.filter((r) => r.opinion.stance === "disagree").length;
	const confidence =
		Math.round(
			(Math.min(10, avgReviewScore) * 0.6 + Math.min(10, (agreements / Math.max(1, results.length)) * 10) * 0.4) *
				10,
		) / 10;

	const topConcern = results
		.filter((r) => r.opinion.stance === "disagree" || r.opinion.stance === "mixed")
		.sort((a, b) => b.opinion.confidence - a.opinion.confidence)[0]?.opinion.title;

	const verdict: CouncilVerdict = {
		summary: `${agreements}/${results.length} advisors agree; ${disagreements} disagree. ${topConcern ?? "No strong dissent."}`,
		confidence,
		advisors: results.length,
		avgReviewScore: Math.round(avgReviewScore * 10) / 10,
		topConcern,
	};

	return { opinions: results, reviews, verdict };
}
