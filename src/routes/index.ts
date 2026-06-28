import { Router, Request, Response } from 'express';
import Team from '../models/Team';
import { register, login, forgotPassword, resetPassword } from '../controllers/authController';
import { createCourse, getCourses, getCourse, deleteCourse } from '../controllers/courseController';
import { createTeam, getTeams, getTeam, updateTeam, deleteTeam, addStudentToTeam, getTeamStudents, getTeamStudent, updateTeamStudent, deleteTeamStudent } from '../controllers/teamController';
import { protect, AuthRequest } from '../middlewares/auth';
import ActivityLog from '../models/ActivityLog';
import { generateTeamProgressReport, generateCourseOverview, answerTeacherQuery } from '../agents/progressAgent';
import { syncTeamRepo, previewGithubContributors, ContributorPreview } from '../services/githubService';
import { syncDriveFolder, previewDriveContributors } from '../services/driveService';

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

// Activity Logs (protected)
router.post('/teams/:teamId/activity', protect, async (req: Request, res: Response) => {
	try {
		const log = await ActivityLog.create({
			...req.body,
			teamId: req.params.teamId,
		});
		res.status(201).json(log);
	} catch (error) {
		res.status(500).json({ message: 'Server error', error });
	}
});

router.get('/teams/:teamId/activity', protect, async (req: Request, res: Response) => {
	try {
		const logs = await ActivityLog.find({ teamId: req.params.teamId }).sort({ timestamp: -1 }).limit(50);
		res.json(logs);
	} catch (error) {
		res.status(500).json({ message: 'Server error', error });
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
		res.status(500).json({ message: 'Failed to preview contributors', error: (error as Error).message });
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
		res.status(500).json({ message: 'Failed to import contributors', error: (error as Error).message });
	}
});

// GitHub sync (protected)
router.post('/teams/:teamId/sync-github', protect, async (req: Request, res: Response) => {
	try {
		const result = await syncTeamRepo(req.params.teamId);
		res.json({ ok: true, result });
	} catch (error) {
		res.status(500).json({ message: 'Failed to sync GitHub', error: (error as Error).message });
	}
});

// Google Drive sync (protected)
router.post('/teams/:teamId/sync-drive', protect, async (req: Request, res: Response) => {
	try {
		await syncDriveFolder(req.params.teamId);
		res.json({ ok: true });
	} catch (error) {
		res.status(500).json({ message: 'Failed to sync Drive', error: (error as Error).message });
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
		res.status(500).json({ message: 'Failed to generate report', error });
	}
});

// GET /courses/:courseId/report
// Natural language overview of all teams in the course
router.get('/courses/:courseId/report', protect, async (req: Request, res: Response) => {
	try {
		const overview = await generateCourseOverview(req.params.courseId);
		res.json({ overview });
	} catch (error) {
		res.status(500).json({ message: 'Failed to generate course overview', error });
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
		res.status(500).json({ message: 'Failed to process query', error });
	}
});

export default router;
