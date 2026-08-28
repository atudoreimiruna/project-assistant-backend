import { Router, Request, Response } from 'express';
import { errorMessage } from '../utils/errors';
import Team from '../models/Team';
import Course from '../models/Course';
import { register, login, forgotPassword, resetPassword } from '../controllers/authController';
import { createCourse, getCourses, getCourse, deleteCourse, createCourseMilestone, updateCourseMilestone, deleteCourseMilestone } from '../controllers/courseController';
import { createTeam, getTeams, getTeam, updateTeam, deleteTeam, addStudentToTeam, getTeamStudents, getTeamStudent, updateTeamStudent, deleteTeamStudent, updateTeamMilestone, getTeamStudentActivity, sendTeamReminders } from '../controllers/teamController';
import { protect, AuthRequest } from '../middlewares/auth';
import ActivityLog from '../models/ActivityLog';
import { generateTeamProgressReport, generateCourseOverview, answerTeacherQuery, answerTeamQuery, autoCheckMilestones } from '../agents/progressAgent';
import { syncTeamRepo, previewGithubContributors, ContributorPreview } from '../services/githubService';
import { syncDriveFolder, previewDriveContributors, syncDriveActivity } from '../services/driveService';
import { buildCourseExportWorkbook } from '../services/exportService';

const router = Router();

// Auth
router.post('/auth/register', register);
router.post('/auth/login', login);
router.post('/auth/forgot-password', forgotPassword);
router.post('/auth/reset-password/:token', resetPassword);

// Courses (protected)
router.get('/courses', protect, getCourses);
router.post('/courses', protect, createCourse);
router.get('/courses/:id', protect, getCourse);
router.delete('/courses/:id', protect, deleteCourse);

// Course-wide milestones (protected) — created here, applied to every team in the course
router.post('/courses/:courseId/milestones', protect, createCourseMilestone);
router.put('/courses/:courseId/milestones/:milestoneId', protect, updateCourseMilestone);
router.delete('/courses/:courseId/milestones/:milestoneId', protect, deleteCourseMilestone);

// GET /courses/:courseId/export — bulk .xlsx export of every team in the course
// (members, per-member contribution, first/last activity, milestones)
router.get('/courses/:courseId/export', protect, async (req: AuthRequest, res: Response) => {
	try {
		const course = await Course.findOne({ _id: req.params.courseId, teacherId: req.teacher?.id });
		if (!course) {
			res.status(404).json({ message: 'Course not found' });
			return;
		}

		const workbook = await buildCourseExportWorkbook(req.params.courseId);
		const safeTitle = course.title.replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').toLowerCase() || 'course';
		const dateStr = new Date().toISOString().slice(0, 10);

		res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
		res.setHeader('Content-Disposition', `attachment; filename="${safeTitle}_teams_export_${dateStr}.xlsx"`);
		await workbook.xlsx.write(res);
		res.end();
	} catch (error) {
		res.status(500).json({ message: 'Failed to export course', error: errorMessage(error) });
	}
});

// Teams (protected)
router.get('/courses/:courseId/teams', protect, getTeams);
router.post('/courses/:courseId/teams', protect, createTeam);
router.get('/teams/:id', protect, getTeam);
router.put('/teams/:id', protect, updateTeam);
router.delete('/teams/:id', protect, deleteTeam);

router.post('/teams/:teamId/students', protect, addStudentToTeam);
router.get('/teams/:teamId/students', protect, getTeamStudents);
router.get('/teams/:teamId/students/:studentId', protect, getTeamStudent);
router.put('/teams/:teamId/students/:studentId', protect, updateTeamStudent);
router.delete('/teams/:teamId/students/:studentId', protect, deleteTeamStudent);
router.get('/teams/:teamId/students/:studentId/activity', protect, getTeamStudentActivity);
router.post('/teams/:teamId/send-reminder', protect, sendTeamReminders);

// Per-team milestone completion toggle (protected) — the milestone itself
// (title/description/dueDate) is managed on the course; this only flips `completed`
router.put('/teams/:teamId/milestones/:milestoneId', protect, updateTeamMilestone);

// POST /teams/:teamId/auto-check-milestones (protected)
// Analyzes the team's recorded activity (commits/PRs/documents) and marks pending
// milestones done wherever the AI finds clear evidence. Never un-checks a milestone —
// a manual "done" from the professor always sticks.
router.post('/teams/:teamId/auto-check-milestones', protect, async (req: Request, res: Response) => {
	try {
		const result = await autoCheckMilestones(req.params.teamId);
		res.json({ ok: true, result });
	} catch (error) {
		res.status(500).json({ message: 'Failed to auto-check milestones', error: errorMessage(error) });
	}
});

// Activity Logs (protected)
router.post('/teams/:teamId/activity', protect, async (req: Request, res: Response) => {
	try {
		const log = await ActivityLog.create({
			...req.body,
			teamId: req.params.teamId,
		});
		res.status(201).json(log);
	} catch (error) {
		res.status(500).json({ message: 'Server error', error: errorMessage(error) });
	}
});

router.get('/teams/:teamId/activity', protect, async (req: Request, res: Response) => {
	try {
		const logs = await ActivityLog.find({ teamId: req.params.teamId }).sort({ timestamp: -1 }).limit(50);
		res.json(logs);
	} catch (error) {
		res.status(500).json({ message: 'Server error', error: errorMessage(error) });
	}
});

// Preview contributors (protected)
// GET /teams/:teamId/preview-contributors?source=github|drive
router.get('/teams/:teamId/preview-contributors', protect, async (req: Request, res: Response) => {
	try {
		const source = req.query.source as string;
		let previews: ContributorPreview[];
		if (source === 'github') {
			previews = await previewGithubContributors(req.params.teamId);
		} else if (source === 'drive') {
			previews = await previewDriveContributors(req.params.teamId);
		} else {
			res.status(400).json({ message: 'source must be github or drive' });
			return;
		}
		res.json(previews);
	} catch (error) {
		res.status(500).json({ message: 'Failed to preview contributors', error: errorMessage(error) });
	}
});

// Import selected contributors (protected)
// POST /teams/:teamId/import-contributors
// body: { contributors: ContributorPreview[] }
router.post('/teams/:teamId/import-contributors', protect, async (req: Request, res: Response) => {
	try {
		const { contributors } = req.body as { contributors: ContributorPreview[] };
		if (!Array.isArray(contributors)) {
			res.status(400).json({ message: 'contributors must be an array' });
			return;
		}

		const team = await Team.findById(req.params.teamId);
		if (!team) { res.status(404).json({ message: 'Team not found' }); return; }

		const existingEmails = new Set(team.students.map((s: any) => (s.email as string).toLowerCase()));
		const existingUsernames = new Set(
			team.students.filter((s: any) => s.githubUsername).map((s: any) => (s.githubUsername as string).toLowerCase()),
		);

		for (const c of contributors) {
			if (existingEmails.has(c.email.toLowerCase())) continue;
			if (c.githubUsername && existingUsernames.has(c.githubUsername.toLowerCase())) continue;
			team.students.push({ name: c.name, email: c.email, githubUsername: c.githubUsername });
			existingEmails.add(c.email.toLowerCase());
			if (c.githubUsername) existingUsernames.add(c.githubUsername.toLowerCase());
		}

		await team.save();
		res.json(team);
	} catch (error) {
		res.status(500).json({ message: 'Failed to import contributors', error: errorMessage(error) });
	}
});

// GitHub sync (protected)
router.post('/teams/:teamId/sync-github', protect, async (req: Request, res: Response) => {
	try {
		const result = await syncTeamRepo(req.params.teamId);
		res.json({ ok: true, result });
	} catch (error) {
		res.status(500).json({ message: 'Failed to sync GitHub', error: errorMessage(error) });
	}
});

// Google Drive sync (protected)
router.post('/teams/:teamId/sync-drive', protect, async (req: Request, res: Response) => {
	try {
		await syncDriveFolder(req.params.teamId);
		res.json({ ok: true });
	} catch (error) {
		res.status(500).json({ message: 'Failed to sync Drive', error: errorMessage(error) });
	}
});

// Google Drive activity sync (protected) — checks linked Docs/Sheets/Slides for new edits
router.post('/teams/:teamId/sync-drive-activity', protect, async (req: Request, res: Response) => {
	try {
		const result = await syncDriveActivity(req.params.teamId);
		res.json({ ok: true, result });
	} catch (error) {
		res.status(500).json({ message: 'Failed to sync Drive activity', error: errorMessage(error) });
	}
});

// AI Agent endpoints (protected)

// GET /teams/:teamId/report
// Returns a structured progress report
// Add ?refresh=true to force a fresh Claude call regardless of cache age
router.get('/teams/:teamId/report', protect, async (req: Request, res: Response) => {
	try {
		const forceRefresh = req.query.refresh === 'true';
		const report = await generateTeamProgressReport(req.params.teamId, forceRefresh);
		res.json(report);
	} catch (error) {
		res.status(500).json({ message: 'Failed to generate report', error: errorMessage(error) });
	}
});

// GET /courses/:courseId/report
// Natural language overview of all teams in the course
router.get('/courses/:courseId/report', protect, async (req: Request, res: Response) => {
	try {
		const overview = await generateCourseOverview(req.params.courseId);
		res.json({ overview });
	} catch (error) {
		res.status(500).json({ message: 'Failed to generate course overview', error: errorMessage(error) });
	}
});

// POST /courses/:courseId/ask
// Answer a natural language question about the course
router.post('/courses/:courseId/ask', protect, async (req: AuthRequest, res: Response) => {
	try {
		const { query } = req.body;
		if (!query) {
			res.status(400).json({ message: 'query is required' });
			return;
		}
		const answer = await answerTeacherQuery(query, req.params.courseId);
		res.json({ answer });
	} catch (error) {
		res.status(500).json({ message: 'Failed to process query', error: errorMessage(error) });
	}
});

// POST /teams/:teamId/ask
// Answer a natural language question scoped to a single team
router.post('/teams/:teamId/ask', protect, async (req: AuthRequest, res: Response) => {
	try {
		const { query } = req.body;
		if (!query) {
			res.status(400).json({ message: 'query is required' });
			return;
		}
		const answer = await answerTeamQuery(query, req.params.teamId);
		res.json({ answer });
	} catch (error) {
		res.status(500).json({ message: 'Failed to process query', error: errorMessage(error) });
	}
});

export default router;
