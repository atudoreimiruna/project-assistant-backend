import Anthropic from '@anthropic-ai/sdk';
import { IActivityLogDoc } from '../models/ActivityLog';
import { IStudentBreakdown } from '../models/TeamReport';

export const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// How old a cached report can be before we regenerate (in ms). 24 hours.
export const REPORT_TTL_MS = 24 * 60 * 60 * 1000;

/** Window of activity every prompt in this module reasons over. */
export const ACTIVITY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export const activitySince = (): Date => new Date(Date.now() - ACTIVITY_WINDOW_MS);

// Count commits/PRs per student email from activity logs.
export function buildStudentBreakdown(
	activities: IActivityLogDoc[],
	students: { name: string; email: string }[],
): IStudentBreakdown[] {
	const byEmail: Record<string, { commits: number; prs: number }> = {};

	for (const a of activities) {
		const email = a.studentEmail?.toLowerCase();
		if (!email) continue;
		if (!byEmail[email]) byEmail[email] = { commits: 0, prs: 0 };
		if (a.type === 'commit') byEmail[email].commits++;
		if (a.type === 'pr') byEmail[email].prs++;
	}

	const maxActivity = Math.max(1, ...Object.values(byEmail).map((v) => v.commits + v.prs * 2));

	return students.map((s) => {
		const email = s.email.toLowerCase();
		const counts = byEmail[email] ?? { commits: 0, prs: 0 };
		const raw = counts.commits + counts.prs * 2;
		return {
			email,
			name: s.name,
			commits: counts.commits,
			prs: counts.prs,
			contributionScore: Math.round((raw / maxActivity) * 100),
		};
	});
}

/** Claude may return more than one content block; take the first text one. */
export function firstTextBlock(message: Anthropic.Message): string {
	for (const block of message.content) {
		if (block.type === 'text') return block.text;
	}
	return '';
}
