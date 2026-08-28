import Team from '../models/Team';
import ActivityLog from '../models/ActivityLog';
import { ITeamReportDoc } from '../models/TeamReport';
import { runTeamReportGraph } from './graphs/teamReportGraph';
import { anthropic, buildStudentBreakdown, firstTextBlock, activitySince } from './shared';

export { buildStudentBreakdown } from './shared';
export { teamReportGraph } from './graphs/teamReportGraph';

/**
 * Per-team progress report.
 *
 * The flow is a LangGraph state machine (see graphs/teamReportGraph.ts):
 *   load team data -> check cache -(fresh?)-> end
 *                                 \-> build prompt -> call Claude -> parse
 *                                       -(ok?)-> persist -> end
 *                                       -(no)-> transient report -> end
 */
export const generateTeamProgressReport = (teamId: string, forceRefresh = false): Promise<ITeamReportDoc> =>
	runTeamReportGraph(teamId, forceRefresh);

/*
 * The three functions below are still single-shot prompt-and-parse calls — one
 * Claude request each, no branching, nothing to orchestrate. They stay on the
 * SDK directly until they grow steps worth graphing (retrieval, tool use, a
 * critique pass), at which point they move into graphs/ alongside the report.
 */

// Course-level overview across all teams
export const generateCourseOverview = async (courseId: string): Promise<string> => {
	const teams = await Team.find({ courseId });
	const since = activitySince();

	const teamData = await Promise.all(
		teams.map(async (team) => {
			const activities = await ActivityLog.find({ teamId: team._id, timestamp: { $gte: since } });
			const overdue = team.milestones.filter((m) => !m.completed && new Date(m.dueDate) < new Date());
			return {
				name: team.name,
				studentCount: team.students.length,
				activityCount: activities.length,
				pendingMilestones: team.milestones.filter((m) => !m.completed).length,
				overdueMilestones: overdue.length,
				overdueNames: overdue.map((m) => m.title),
			};
		}),
	);

	const prompt = `
You are an AI assistant helping a university professor get a high-level view of all project teams.

Course has ${teams.length} teams. Here is a summary of each team's last 7 days:
${teamData
	.map((t) => `- "${t.name}" (${t.studentCount} students): ${t.activityCount} activities, ${t.pendingMilestones} pending milestones, ${t.overdueMilestones} overdue (${t.overdueNames.join(', ') || 'none'})`)
	.join('\n')}

Provide a concise course-level summary for the professor:
1. Overall health of the course (1-2 sentences)
2. Teams that need attention and why
3. Any patterns or concerns across teams

Keep it to 150 words or fewer.
`.trim();

	const message = await anthropic.messages.create({
		model: 'claude-haiku-4-5-20251001',
		max_tokens: 400,
		messages: [{ role: 'user', content: prompt }],
	});

	return firstTextBlock(message);
};

// Natural language query from teacher, scoped to a course
export const answerTeacherQuery = async (query: string, courseId: string): Promise<string> => {
	const teams = await Team.find({ courseId });
	const since = activitySince();

	const teamData = await Promise.all(
		teams.map(async (team) => {
			const activities = await ActivityLog.find({ teamId: team._id, timestamp: { $gte: since } }).sort({
				timestamp: -1,
			});
			const overdue = team.milestones.filter((m) => !m.completed && new Date(m.dueDate) < new Date());

			return {
				name: team.name,
				students: team.students.map((s) => s.name),
				activities: activities.slice(0, 20).map((a) => ({
					type: a.type,
					description: a.description,
					studentEmail: a.studentEmail,
					timestamp: a.timestamp.toISOString(),
				})),
				pendingMilestones: team.milestones.filter((m) => !m.completed).map((m) => m.title),
				overdueMilestones: overdue.map((m) => m.title),
				studentBreakdown: buildStudentBreakdown(activities, team.students),
			};
		}),
	);

	const prompt = `
You are an AI assistant helping a university professor manage student project teams.

Here is the full course data for the last 7 days:
${JSON.stringify(teamData, null, 2)}

Professor's question: ${query}

Answer concisely and accurately based only on the data above. If the data doesn't contain enough information to answer, say so.
`.trim();

	const message = await anthropic.messages.create({
		model: 'claude-haiku-4-5-20251001',
		max_tokens: 500,
		messages: [{ role: 'user', content: prompt }],
	});

	return firstTextBlock(message);
};

// Natural language query scoped to a single team
export const answerTeamQuery = async (query: string, teamId: string): Promise<string> => {
	const team = await Team.findById(teamId);
	if (!team) throw new Error('Team not found');

	const activities = await ActivityLog.find({ teamId: team._id, timestamp: { $gte: activitySince() } }).sort({
		timestamp: -1,
	});

	const overdue = team.milestones.filter((m) => !m.completed && new Date(m.dueDate) < new Date());

	const teamData = {
		name: team.name,
		students: team.students.map((s) => ({ name: s.name, email: s.email, githubUsername: s.githubUsername })),
		githubRepo: team.githubRepo || null,
		activities: activities.slice(0, 30).map((a) => ({
			type: a.type,
			description: a.description,
			studentEmail: a.studentEmail,
			timestamp: a.timestamp.toISOString(),
		})),
		pendingMilestones: team.milestones.filter((m) => !m.completed).map((m) => ({ title: m.title, dueDate: m.dueDate })),
		overdueMilestones: overdue.map((m) => m.title),
		studentBreakdown: buildStudentBreakdown(activities, team.students),
	};

	const prompt = `
You are an AI assistant helping a university professor monitor a specific student project team.

Team data for the last 7 days:
${JSON.stringify(teamData, null, 2)}

Professor's question: ${query}

Answer concisely and accurately based only on the data above. Use student names, not emails, in your answer. If the data doesn't contain enough information to answer, say so clearly.
`.trim();

	const message = await anthropic.messages.create({
		model: 'claude-haiku-4-5-20251001',
		max_tokens: 400,
		messages: [{ role: 'user', content: prompt }],
	});

	return firstTextBlock(message);
};

export interface MilestoneCheckResult {
	milestoneId: string;
	title: string;
	reason: string;
}

export interface AutoCheckMilestonesResult {
	checked: number;
	newlyCompleted: MilestoneCheckResult[];
	stillPending: MilestoneCheckResult[];
}

/**
 * Looks at everything recorded for a team (commits, PRs, document edits) and asks
 * Claude which of its still-open milestones the evidence actually supports as done.
 * Conservative by design, in both directions:
 *   - a milestone is only ever flipped NOT-done -> done, never the reverse, so a
 *     professor's manual "done" always sticks regardless of what the AI thinks later
 *   - the AI is instructed to leave a milestone pending whenever the evidence is
 *     ambiguous rather than guess
 */
export const autoCheckMilestones = async (teamId: string): Promise<AutoCheckMilestonesResult> => {
	const team = await Team.findById(teamId);
	if (!team) throw new Error('Team not found');

	const pending = team.milestones.filter((m) => !m.completed);
	if (pending.length === 0) {
		return { checked: 0, newlyCompleted: [], stillPending: [] };
	}

	// Full history, not the rolling 7-day window the status report uses — a
	// milestone finished three weeks ago should still count as done. Capped so a
	// very long-running project doesn't blow up the prompt.
	const MAX_ACTIVITY_EVENTS = 500;
	const allActivity = await ActivityLog.find({ teamId }).sort({ timestamp: 1 });
	const activity = allActivity.length > MAX_ACTIVITY_EVENTS ? allActivity.slice(-MAX_ACTIVITY_EVENTS) : allActivity;

	const milestoneList = pending
		.map(
			(m, i) =>
				`${i + 1}. [id: ${m._id}] "${m.title}"${m.description ? ` — ${m.description}` : ''} (due ${new Date(m.dueDate).toISOString().slice(0, 10)})`,
		)
		.join('\n');

	const activityList =
		activity.length === 0
			? 'No activity recorded yet.'
			: activity
					.map((a) => `- [${a.type.toUpperCase()}] ${a.description} (by ${a.studentEmail || 'unknown'}) at ${a.timestamp.toISOString().slice(0, 10)}`)
					.join('\n');

	const prompt = `
You are an AI assistant helping a university professor determine which project milestones a student team has genuinely completed, based on the team's actual recorded project activity (GitHub commits/PRs, Google Docs/Sheets/Slides edits).

Team: ${team.name}
GitHub repo: ${team.githubRepo || 'Not set'}
Google Drive folder: ${team.googleDriveFolder || 'Not set'}
${allActivity.length > MAX_ACTIVITY_EVENTS ? `(Showing the ${MAX_ACTIVITY_EVENTS} most recent of ${allActivity.length} recorded events.)` : ''}

Milestones still marked as NOT completed:
${milestoneList}

Full recorded project activity (chronological):
${activityList}

For EACH milestone above, decide whether the activity clearly demonstrates it has been completed. Be conservative — only mark a milestone done when there is real, specific evidence (matching commits, PRs, or documents). If the evidence is ambiguous, partial, or absent, mark it not done. Never guess.

Respond ONLY with valid JSON — no markdown fences, no extra text:
{
  "results": [
    { "milestoneId": "<id>", "done": true|false, "reason": "<one short sentence citing the evidence, or why it isn't done yet>" }
  ]
}
`.trim();

	const message = await anthropic.messages.create({
		model: 'claude-haiku-4-5-20251001',
		max_tokens: Math.min(1500, 250 + pending.length * 150),
		messages: [{ role: 'user', content: prompt }],
	});

	const rawText = firstTextBlock(message);

	let parsed: { results?: { milestoneId: string; done: boolean; reason: string }[] } | null = null;
	try {
		const cleaned = rawText
			.replace(/^```(?:json)?\s*/i, '')
			.replace(/\s*```\s*$/, '')
			.trim();
		parsed = JSON.parse(cleaned);
	} catch {
		parsed = null;
	}

	if (!parsed?.results) {
		return {
			checked: pending.length,
			newlyCompleted: [],
			stillPending: pending.map((m) => ({
				milestoneId: String(m._id),
				title: m.title,
				reason: 'Could not parse the AI response — try again.',
			})),
		};
	}

	const byId = new Map(parsed.results.map((r) => [r.milestoneId, r]));
	const newlyCompleted: MilestoneCheckResult[] = [];
	const stillPending: MilestoneCheckResult[] = [];
	let changed = false;

	for (const m of pending) {
		const idStr = String(m._id);
		const result = byId.get(idStr);
		if (result?.done) {
			m.completed = true;
			changed = true;
			newlyCompleted.push({ milestoneId: idStr, title: m.title, reason: result.reason || 'Marked complete by AI review.' });
		} else {
			stillPending.push({ milestoneId: idStr, title: m.title, reason: result?.reason || 'Not enough evidence yet.' });
		}
	}

	if (changed) await team.save();

	return { checked: pending.length, newlyCompleted, stillPending };
};
