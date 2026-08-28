/**
 * Course-wide "export all teams" — builds an .xlsx workbook with one summary
 * sheet plus one sheet per team, covering members, per-member contribution,
 * and first/last activity. Stats are computed over the team's *entire*
 * activity history (not the 7-day window the AI report uses), since this is
 * meant to be an archival/reporting artifact rather than a live snapshot.
 */

import ExcelJS from 'exceljs';
import Course from '../models/Course';
import Team from '../models/Team';
import ActivityLog, { IActivityLogDoc } from '../models/ActivityLog';

interface ExportStudent {
	name: string;
	email: string;
	githubUsername?: string;
}

interface StudentExportRow {
	name: string;
	email: string;
	githubUsername?: string;
	commits: number;
	prs: number;
	documents: number;
	totalEvents: number;
	contributionScore: number;
	firstActivity: Date | null;
	lastActivity: Date | null;
}

const fmtDate = (d: Date | null | undefined): string => (d ? d.toISOString().slice(0, 10) : '—');

/**
 * Per-member breakdown across the full activity history handed in. Mirrors
 * agents/shared.ts#buildStudentBreakdown's scoring (commits + PRs*2, relative
 * to the team's top contributor) but also folds in Drive document edits and
 * tracks each member's first/last activity date.
 */
function buildExportBreakdown(activities: IActivityLogDoc[], students: ExportStudent[]): StudentExportRow[] {
	const byEmail: Record<string, { commits: number; prs: number; documents: number; first: Date; last: Date }> = {};

	for (const a of activities) {
		const email = a.studentEmail?.toLowerCase();
		if (!email) continue;
		if (!byEmail[email]) byEmail[email] = { commits: 0, prs: 0, documents: 0, first: a.timestamp, last: a.timestamp };
		const bucket = byEmail[email];
		if (a.type === 'commit') bucket.commits++;
		else if (a.type === 'pr') bucket.prs++;
		else if (a.type === 'document') bucket.documents++;
		if (a.timestamp < bucket.first) bucket.first = a.timestamp;
		if (a.timestamp > bucket.last) bucket.last = a.timestamp;
	}

	const maxRaw = Math.max(1, ...Object.values(byEmail).map((v) => v.commits + v.prs * 2 + v.documents));

	return students.map((s) => {
		const email = s.email.toLowerCase();
		const b = byEmail[email];
		if (!b) {
			return {
				name: s.name,
				email: s.email,
				githubUsername: s.githubUsername,
				commits: 0,
				prs: 0,
				documents: 0,
				totalEvents: 0,
				contributionScore: 0,
				firstActivity: null,
				lastActivity: null,
			};
		}
		const raw = b.commits + b.prs * 2 + b.documents;
		return {
			name: s.name,
			email: s.email,
			githubUsername: s.githubUsername,
			commits: b.commits,
			prs: b.prs,
			documents: b.documents,
			totalEvents: b.commits + b.prs + b.documents,
			contributionScore: Math.round((raw / maxRaw) * 100),
			firstActivity: b.first,
			lastActivity: b.last,
		};
	});
}

/** Excel sheet names: <=31 chars, no : \ / ? * [ ], and must be unique per workbook. */
const sanitizeSheetName = (name: string, used: Set<string>): string => {
	const base = name.replace(/[:\\/?*[\]]/g, ' ').trim().slice(0, 31) || 'Team';
	let candidate = base;
	let i = 2;
	while (used.has(candidate.toLowerCase())) {
		const suffix = ` (${i})`;
		candidate = base.slice(0, 31 - suffix.length) + suffix;
		i++;
	}
	used.add(candidate.toLowerCase());
	return candidate;
};

function styleHeaderRow(row: ExcelJS.Row) {
	row.eachCell((cell) => {
		cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
		cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0C3B2E' } };
		cell.alignment = { vertical: 'middle' };
	});
	row.height = 20;
}

export const buildCourseExportWorkbook = async (courseId: string): Promise<ExcelJS.Workbook> => {
	const course = await Course.findById(courseId);
	if (!course) throw new Error('Course not found');

	const teams = await Team.find({ courseId }).sort({ name: 1 });

	const workbook = new ExcelJS.Workbook();
	workbook.creator = 'TeamLens';
	workbook.created = new Date();

	const summarySheet = workbook.addWorksheet('Summary');
	summarySheet.columns = [
		{ header: 'Team', key: 'team', width: 24 },
		{ header: 'GitHub Repo', key: 'repo', width: 32 },
		{ header: 'Google Drive', key: 'drive', width: 32 },
		{ header: 'Members', key: 'members', width: 10 },
		{ header: 'Commits', key: 'commits', width: 10 },
		{ header: 'PRs', key: 'prs', width: 8 },
		{ header: 'Doc updates', key: 'documents', width: 12 },
		{ header: 'Total activity', key: 'total', width: 14 },
		{ header: 'First activity', key: 'first', width: 14 },
		{ header: 'Last activity', key: 'last', width: 14 },
		{ header: 'Milestones', key: 'milestones', width: 12 },
		{ header: 'Overdue milestones', key: 'overdue', width: 17 },
	];
	styleHeaderRow(summarySheet.getRow(1));
	summarySheet.autoFilter = 'A1:L1';

	if (teams.length === 0) {
		summarySheet.addRow({ team: 'No teams in this course yet.' });
		return workbook;
	}

	const usedSheetNames = new Set<string>(['summary']);

	for (const team of teams) {
		const activities = await ActivityLog.find({ teamId: team._id }).sort({ timestamp: 1 });
		const students: ExportStudent[] = team.students.map((s: any) => ({
			name: s.name,
			email: s.email,
			githubUsername: s.githubUsername,
		}));
		const breakdown = buildExportBreakdown(activities, students);

		const teamFirst = activities[0]?.timestamp ?? null;
		const teamLast = activities.length > 0 ? activities[activities.length - 1].timestamp : null;
		const totalCommits = activities.filter((a) => a.type === 'commit').length;
		const totalPrs = activities.filter((a) => a.type === 'pr').length;
		const totalDocs = activities.filter((a) => a.type === 'document').length;
		const completedMilestones = team.milestones.filter((m) => m.completed).length;
		const overdue = team.milestones.filter((m) => !m.completed && new Date(m.dueDate) < new Date()).length;

		summarySheet.addRow({
			team: team.name,
			repo: team.githubRepo || '—',
			drive: team.googleDriveFolder || '—',
			members: team.students.length,
			commits: totalCommits,
			prs: totalPrs,
			documents: totalDocs,
			total: activities.length,
			first: fmtDate(teamFirst),
			last: fmtDate(teamLast),
			milestones: `${completedMilestones}/${team.milestones.length}`,
			overdue,
		});

		const sheetName = sanitizeSheetName(team.name, usedSheetNames);
		const sheet = workbook.addWorksheet(sheetName);
		sheet.columns = [
			{ header: 'Member', key: 'name', width: 22 },
			{ header: 'Email', key: 'email', width: 28 },
			{ header: 'GitHub username', key: 'github', width: 18 },
			{ header: 'Commits', key: 'commits', width: 10 },
			{ header: 'PRs', key: 'prs', width: 8 },
			{ header: 'Doc updates', key: 'documents', width: 12 },
			{ header: 'Total activity', key: 'total', width: 14 },
			{ header: 'Contribution score', key: 'score', width: 17 },
			{ header: 'First activity', key: 'first', width: 14 },
			{ header: 'Last activity', key: 'last', width: 14 },
		];
		styleHeaderRow(sheet.getRow(1));
		if (breakdown.length > 0) sheet.autoFilter = 'A1:J1';

		if (breakdown.length === 0) {
			sheet.addRow({ name: 'No members in this team yet.' });
		}
		for (const row of breakdown) {
			sheet.addRow({
				name: row.name,
				email: row.email,
				github: row.githubUsername || '—',
				commits: row.commits,
				prs: row.prs,
				documents: row.documents,
				total: row.totalEvents,
				score: row.contributionScore,
				first: fmtDate(row.firstActivity),
				last: fmtDate(row.lastActivity),
			});
		}

		sheet.addRow([]);
		sheet.addRow(['Team first activity', fmtDate(teamFirst)]);
		sheet.addRow(['Team last activity', fmtDate(teamLast)]);
		sheet.addRow(['Milestones completed', `${completedMilestones}/${team.milestones.length}`]);
		if (overdue > 0) sheet.addRow(['Overdue milestones', overdue]);
	}

	return workbook;
};
