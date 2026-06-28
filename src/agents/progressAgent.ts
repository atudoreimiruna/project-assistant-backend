import Anthropic from '@anthropic-ai/sdk';
import ActivityLog, { IActivityLogDoc } from '../models/ActivityLog';
import Team from '../models/Team';
import TeamReport, { ITeamReportDoc, IStudentBreakdown } from '../models/TeamReport';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// How old a cached report can be before we regenerate (in ms).
// 24 hours
const REPORT_TTL_MS = 24 * 60 * 60 * 1000;

// Count commits/PRs per student email from activity logs.
function buildStudentBreakdown(activities: IActivityLogDoc[], students: { name: string; email: string }[]): IStudentBreakdown[] {
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

// Per-team progress report
export const generateTeamProgressReport = async (teamId: string, forceRefresh = false): Promise<ITeamReportDoc> => {
	const team = await Team.findById(teamId);
	if (!team) throw new Error('Team not found');

	const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

	const activities = await ActivityLog.find({
		teamId,
		timestamp: { $gte: since },
	}).sort({ timestamp: -1 });

	// Return cached report if fresh enough and activity count hasn't changed
	if (!forceRefresh) {
		const cached = await TeamReport.findOne({ teamId }).sort({ generatedAt: -1 });
		const cacheAge = cached ? Date.now() - cached.generatedAt.getTime() : Infinity;
		if (cached && cacheAge < REPORT_TTL_MS && cached.activityCount === activities.length) {
			return cached;
		}
	}

	const pendingMilestones = team.milestones.filter((m) => !m.completed);
	const overdueMilestones = pendingMilestones.filter((m) => new Date(m.dueDate) < new Date());
	const studentBreakdown = buildStudentBreakdown(activities, team.students);

	const prompt = `
You are an AI assistant helping a university professor monitor student project teams.
Respond ONLY with valid JSON — no markdown fences, no extra text.

Team: ${team.name}
Students: ${team.students.map((s) => `${s.name} <${s.email}>`).join(', ')}
GitHub Repo: ${team.githubRepo || 'Not set'}

Recent activity (last 7 days):
${activities.length === 0 ? 'No activity recorded.' : activities.map((a) => `- [${a.type.toUpperCase()}] ${a.description} (by ${a.studentEmail || 'unknown'}) at ${a.timestamp.toISOString()}`).join('\n')}

Per-student contribution (last 7 days):
${studentBreakdown.map((s) => `- ${s.name}: ${s.commits} commits, ${s.prs} PRs`).join('\n')}

Pending milestones: ${pendingMilestones.length}
Overdue milestones: ${overdueMilestones.map((m) => m.title).join(', ') || 'None'}

Return a JSON object with exactly these fields:
{
  "summary": "<2-3 sentence progress summary>",
  "status": "<ON_TRACK | AT_RISK | BLOCKED>",
  "concerns": ["<concern 1>", ...],
  "recommendations": ["<recommendation 1>", ...]
}
`.trim();

	const message = await anthropic.messages.create({
		model: 'claude-haiku-4-5-20251001',
		max_tokens: 600,
		messages: [{ role: 'user', content: prompt }],
	});

	const rawText = message.content[0].type === 'text' ? message.content[0].text : '';

	let parsed: { summary: string; status: string; concerns: string[]; recommendations: string[] };
	try {
		const cleanedText = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
		parsed = JSON.parse(cleanedText);
	} catch {
		// Fallback: treat entire response as summary if JSON parse fails
		parsed = {
			summary: rawText,
			status: 'AT_RISK',
			concerns: ['Could not parse structured response from AI.'],
			recommendations: [],
		};
	}

	const validStatuses = ['ON_TRACK', 'AT_RISK', 'BLOCKED'];
	const status = validStatuses.includes(parsed.status) ? (parsed.status as 'ON_TRACK' | 'AT_RISK' | 'BLOCKED') : 'AT_RISK';

	// Upsert: replace latest report for this team
	const report = await TeamReport.findOneAndUpdate(
		{ teamId },
		{
			$set: {
				teamId,
				generatedAt: new Date(),
				activityCount: activities.length,
				summary: parsed.summary ?? '',
				status,
				concerns: parsed.concerns ?? [],
				recommendations: parsed.recommendations ?? [],
				studentBreakdown,
				rawText,
			},
		},
		{ upsert: true, new: true },
	);

	return report!;
};

// Course-level overview across all teams
export const generateCourseOverview = async (courseId: string): Promise<string> => {
	const teams = await Team.find({ courseId });
	const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

	const teamData = await Promise.all(
		teams.map(async (team) => {
			const activities = await ActivityLog.find({
				teamId: team._id,
				timestamp: { $gte: since },
			});
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

	return message.content[0].type === 'text' ? message.content[0].text : '';
};

// Natural language query from teacher
export const answerTeacherQuery = async (query: string, courseId: string): Promise<string> => {
	const teams = await Team.find({ courseId });
	const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

	const teamData = await Promise.all(
		teams.map(async (team) => {
			const activities = await ActivityLog.find({
				teamId: team._id,
				timestamp: { $gte: since },
			}).sort({ timestamp: -1 });

			const overdue = team.milestones.filter((m) => !m.completed && new Date(m.dueDate) < new Date());

			const studentBreakdown = buildStudentBreakdown(activities, team.students);

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
				studentBreakdown,
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

	return message.content[0].type === 'text' ? message.content[0].text : '';
};
