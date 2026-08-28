import { Annotation, StateGraph, START, END } from '@langchain/langgraph';
import ActivityLog, { IActivityLogDoc } from '../../models/ActivityLog';
import Team, { ITeamDoc } from '../../models/Team';
import TeamReport, { ITeamReportDoc, IStudentBreakdown } from '../../models/TeamReport';
import { anthropic, buildStudentBreakdown, firstTextBlock, activitySince, REPORT_TTL_MS } from '../shared';

export type ReportStatus = 'ON_TRACK' | 'AT_RISK' | 'BLOCKED';

interface ParsedReport {
	summary: string;
	status: string;
	concerns: string[];
	recommendations: string[];
}

/** Last-value channel with an explicit default, so nodes never read an empty channel. */
function channel<T>(initial: () => T) {
	return Annotation<T>({ reducer: (_prev: T, next: T) => next, default: initial });
}

const ReportState = Annotation.Root({
	// inputs
	teamId: channel<string>(() => ''),
	forceRefresh: channel<boolean>(() => false),
	// gathered
	team: channel<ITeamDoc | null>(() => null),
	activities: channel<IActivityLogDoc[]>(() => []),
	studentBreakdown: channel<IStudentBreakdown[]>(() => []),
	// generation
	prompt: channel<string>(() => ''),
	rawText: channel<string>(() => ''),
	parsed: channel<ParsedReport | null>(() => null),
	// output
	report: channel<ITeamReportDoc | null>(() => null),
	servedFromCache: channel<boolean>(() => false),
});

type ReportStateType = typeof ReportState.State;

/* ─── Nodes ──────────────────────────────────────────────── */

async function loadTeamData(state: ReportStateType) {
	const team = await Team.findById(state.teamId);
	if (!team) throw new Error('Team not found');

	const activities = await ActivityLog.find({
		teamId: state.teamId,
		timestamp: { $gte: activitySince() },
	}).sort({ timestamp: -1 });

	return {
		team,
		activities,
		studentBreakdown: buildStudentBreakdown(activities, team.students),
	};
}

async function checkCache(state: ReportStateType) {
	if (state.forceRefresh) return { servedFromCache: false };

	const cached = await TeamReport.findOne({ teamId: state.teamId }).sort({ generatedAt: -1 });
	if (!cached) return { servedFromCache: false };

	const cacheAge = Date.now() - cached.generatedAt.getTime();
	const fresh = cacheAge < REPORT_TTL_MS && cached.activityCount === state.activities.length;

	return fresh ? { report: cached, servedFromCache: true } : { servedFromCache: false };
}

function buildPrompt(state: ReportStateType) {
	const team = state.team!;
	const { activities, studentBreakdown } = state;

	const pendingMilestones = team.milestones.filter((m) => !m.completed);
	const overdueMilestones = pendingMilestones.filter((m) => new Date(m.dueDate) < new Date());

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

	return { prompt };
}

async function callClaude(state: ReportStateType) {
	const message = await anthropic.messages.create({
		model: 'claude-haiku-4-5-20251001',
		max_tokens: 600,
		messages: [{ role: 'user', content: state.prompt }],
	});

	return { rawText: firstTextBlock(message) };
}

function parseResult(state: ReportStateType) {
	try {
		const cleaned = state.rawText
			.replace(/^```(?:json)?\s*/i, '')
			.replace(/\s*```\s*$/, '')
			.trim();
		return { parsed: JSON.parse(cleaned) as ParsedReport };
	} catch {
		return { parsed: null };
	}
}

function normaliseStatus(raw: string | undefined): ReportStatus {
	const valid: ReportStatus[] = ['ON_TRACK', 'AT_RISK', 'BLOCKED'];
	return valid.includes(raw as ReportStatus) ? (raw as ReportStatus) : 'AT_RISK';
}

async function persistReport(state: ReportStateType) {
	const parsed = state.parsed!;

	const report = await TeamReport.findOneAndUpdate(
		{ teamId: state.teamId },
		{
			$set: {
				teamId: state.teamId,
				generatedAt: new Date(),
				activityCount: state.activities.length,
				summary: parsed.summary ?? '',
				status: normaliseStatus(parsed.status),
				concerns: parsed.concerns ?? [],
				recommendations: parsed.recommendations ?? [],
				studentBreakdown: state.studentBreakdown,
				rawText: state.rawText,
			},
		},
		{ upsert: true, new: true },
	);

	return { report };
}

function transientReport(state: ReportStateType) {
	const report = new TeamReport({
		teamId: state.teamId,
		generatedAt: new Date(),
		activityCount: state.activities.length,
		summary: state.rawText,
		status: 'AT_RISK' satisfies ReportStatus,
		concerns: ['Could not parse structured response from AI.'],
		recommendations: [],
		studentBreakdown: state.studentBreakdown,
		rawText: state.rawText,
	});

	return { report };
}

/* ─── Graph ──────────────────────────────────────────────── */

const graph = new StateGraph(ReportState)
	.addNode('loadTeamData', loadTeamData)
	.addNode('checkCache', checkCache)
	.addNode('buildPrompt', buildPrompt)
	.addNode('callClaude', callClaude)
	.addNode('parseResult', parseResult)
	.addNode('persistReport', persistReport)
	.addNode('transientReport', transientReport)
	.addEdge(START, 'loadTeamData')
	.addEdge('loadTeamData', 'checkCache')
	// Fresh cache short-circuits the whole generation branch.
	.addConditionalEdges('checkCache', (s: ReportStateType) => (s.servedFromCache ? END : 'buildPrompt'), [END, 'buildPrompt'])
	.addEdge('buildPrompt', 'callClaude')
	.addEdge('callClaude', 'parseResult')
	.addConditionalEdges('parseResult', (s: ReportStateType) => (s.parsed ? 'persistReport' : 'transientReport'), ['persistReport', 'transientReport'])
	.addEdge('persistReport', END)
	.addEdge('transientReport', END)
	.compile();

export const teamReportGraph = graph;

export async function runTeamReportGraph(teamId: string, forceRefresh = false): Promise<ITeamReportDoc> {
	const final = await graph.invoke({ teamId, forceRefresh });
	if (!final.report) throw new Error('Report graph finished without producing a report');
	return final.report;
}
