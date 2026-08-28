import { Response } from 'express';
import { errorMessage } from '../utils/errors';
import Team from '../models/Team';
import Course from '../models/Course';
import ActivityLog from '../models/ActivityLog';
import { AuthRequest } from '../middlewares/auth';
import { parseRepoUrl, syncTeamRepo, addCollaborator, removeCollaborator, syncTeamCollaborators } from '../services/githubService';
import { parseGoogleFileId, addDriveMember, removeDriveMember, syncDriveFolder } from '../services/driveService';
import { sendDeadlineReminderEmail } from '../services/emailService';

const verifyCourseOwnership = async (courseId: string, teacherId: string | undefined) => {
	return Course.findOne({ _id: courseId, teacherId });
};

const verifyTeamOwnership = async (teamId: string, teacherId: string | undefined) => {
	const team = await Team.findById(teamId);
	if (!team) return null;

	const course = await Course.findOne({ _id: team.courseId, teacherId });
	if (!course) return null;

	return team;
};

export const createTeam = async (req: AuthRequest, res: Response): Promise<void> => {
	try {
		const course = await verifyCourseOwnership(req.params.courseId, req.teacher?.id);
		if (!course) {
			res.status(404).json({ message: 'Course not found' });
			return;
		}

		const body = { ...req.body, courseId: req.params.courseId };

		if (body.githubRepo) {
			const parsed = parseRepoUrl(body.githubRepo);
			if (!parsed) {
				res.status(400).json({ message: 'Invalid GitHub repo URL' });
				return;
			}
			body.githubOwner = parsed.owner;
			body.githubRepoName = parsed.repo;
		}

		if (body.googleDriveFolder && !parseGoogleFileId(body.googleDriveFolder)) {
			res.status(400).json({ message: 'Invalid Google document URL — must be a Docs, Sheets, Slides or Drive link' });
			return;
		}

		// Seed every course-wide milestone onto the new team (own completed flag,
		// linked back via courseMilestoneId so course-level edits/deletes find it).
		// Always derived from the course, never from client input.
		body.milestones = course.milestones.map((m) => ({
			title: m.title,
			description: m.description,
			dueDate: m.dueDate,
			completed: false,
			courseMilestoneId: m._id,
		}));

		const team = await Team.create(body);

		// Fire-and-forget: sync activity logs + add initial students to GitHub/Drive
		// (contributor import is handled explicitly via the preview/import flow)
		if (team.githubOwner) {
			syncTeamRepo(team.id).catch(() => {});
			syncTeamCollaborators(team.id).catch(() => {});
		}
		if (team.googleDriveFolder) {
			syncDriveFolder(team.id).catch(() => {});
		}

		res.status(201).json(team);
	} catch (error) {
		res.status(500).json({ message: 'Server error', error: errorMessage(error) });
	}
};

export const getTeams = async (req: AuthRequest, res: Response): Promise<void> => {
	try {
		const course = await verifyCourseOwnership(req.params.courseId, req.teacher?.id);
		if (!course) {
			res.status(404).json({ message: 'Course not found' });
			return;
		}

		const teams = await Team.find({ courseId: req.params.courseId });
		res.json(teams);
	} catch (error) {
		res.status(500).json({ message: 'Server error', error: errorMessage(error) });
	}
};

export const getTeam = async (req: AuthRequest, res: Response): Promise<void> => {
	try {
		const team = await verifyTeamOwnership(req.params.id, req.teacher?.id);
		if (!team) {
			res.status(404).json({ message: 'Team not found' });
			return;
		}
		res.json(team);
	} catch (error) {
		res.status(500).json({ message: 'Server error', error: errorMessage(error) });
	}
};

export const updateTeam = async (req: AuthRequest, res: Response): Promise<void> => {
	try {
		const team = await verifyTeamOwnership(req.params.id, req.teacher?.id);
		if (!team) {
			res.status(404).json({ message: 'Team not found' });
			return;
		}

		const repoChanged = req.body.githubRepo && req.body.githubRepo !== team.githubRepo;
		const driveChanged = req.body.googleDriveFolder && req.body.googleDriveFolder !== team.googleDriveFolder;

		if (repoChanged) {
			const parsed = parseRepoUrl(req.body.githubRepo);
			if (!parsed) {
				res.status(400).json({ message: 'Invalid GitHub repo URL' });
				return;
			}
			req.body.githubOwner = parsed.owner;
			req.body.githubRepoName = parsed.repo;
		}

		if (driveChanged && !parseGoogleFileId(req.body.googleDriveFolder)) {
			res.status(400).json({ message: 'Invalid Google document URL — must be a Docs, Sheets, Slides or Drive link' });
			return;
		}

		Object.assign(team, req.body);
		await team.save();

		if (repoChanged) {
			syncTeamRepo(team.id).catch(() => {});          // sync activity logs
			syncTeamCollaborators(team.id).catch(() => {}); // add all students as collaborators
		}

		if (driveChanged) {
			syncDriveFolder(team.id).catch(() => {}); // share folder with all students
		}

		res.json(team);
	} catch (error) {
		res.status(500).json({ message: 'Server error', error: errorMessage(error) });
	}
};

export const deleteTeam = async (req: AuthRequest, res: Response): Promise<void> => {
	try {
		const team = await verifyTeamOwnership(req.params.id, req.teacher?.id);
		if (!team) {
			res.status(404).json({ message: 'Team not found' });
			return;
		}

		await team.deleteOne();
		res.json({ message: 'Team deleted' });
	} catch (error) {
		res.status(500).json({ message: 'Server error', error: errorMessage(error) });
	}
};

export const addStudentToTeam = async (req: AuthRequest, res: Response): Promise<void> => {
	try {
		const team = await verifyTeamOwnership(req.params.teamId, req.teacher?.id);
		if (!team) {
			res.status(404).json({ message: 'Team not found' });
			return;
		}

		team.students.push(req.body);
		await team.save();
		const student = team.students[team.students.length - 1];

		// Auto-add to GitHub as collaborator
		if (team.githubOwner && team.githubRepoName && student.githubUsername) {
			addCollaborator(team.githubOwner, team.githubRepoName, student.githubUsername).catch(() => {});
		}

		// Auto-share Google Drive folder
		if (team.googleDriveFolder) {
			const folderId = parseGoogleFileId(team.googleDriveFolder);
			if (folderId) addDriveMember(folderId, student.email).catch(() => {});
		}

		res.status(201).json(student);
	} catch (error) {
		res.status(500).json({ message: 'Server error', error: errorMessage(error) });
	}
};

export const getTeamStudents = async (req: AuthRequest, res: Response): Promise<void> => {
	try {
		const team = await verifyTeamOwnership(req.params.teamId, req.teacher?.id);
		if (!team) {
			res.status(404).json({ message: 'Team not found' });
			return;
		}

		res.json(team.students);
	} catch (error) {
		res.status(500).json({ message: 'Server error', error: errorMessage(error) });
	}
};

export const getTeamStudent = async (req: AuthRequest, res: Response): Promise<void> => {
	try {
		const team = await verifyTeamOwnership(req.params.teamId, req.teacher?.id);
		if (!team) {
			res.status(404).json({ message: 'Team not found' });
			return;
		}

		const student = team.students.id(req.params.studentId);
		if (!student) {
			res.status(404).json({ message: 'Student not found' });
			return;
		}

		res.json(student);
	} catch (error) {
		res.status(500).json({ message: 'Server error', error: errorMessage(error) });
	}
};

export const updateTeamStudent = async (req: AuthRequest, res: Response): Promise<void> => {
	try {
		const team = await verifyTeamOwnership(req.params.teamId, req.teacher?.id);
		if (!team) {
			res.status(404).json({ message: 'Team not found' });
			return;
		}

		const student = team.students.id(req.params.studentId);
		if (!student) {
			res.status(404).json({ message: 'Student not found' });
			return;
		}

		student.set(req.body);
		await team.save();
		res.json(student);
	} catch (error) {
		res.status(500).json({ message: 'Server error', error: errorMessage(error) });
	}
};

// POST /teams/:teamId/send-reminder
// Emails every student on the team about all of the team's still-open
// milestones (title, due date, flagged if already overdue). Can be fired at
// any time from the team page — not tied to any specific schedule.
export const sendTeamReminders = async (req: AuthRequest, res: Response): Promise<void> => {
	try {
		const team = await verifyTeamOwnership(req.params.teamId, req.teacher?.id);
		if (!team) {
			res.status(404).json({ message: 'Team not found' });
			return;
		}

		const pending = team.milestones.filter((m) => !m.completed);
		if (pending.length === 0) {
			res.status(400).json({ message: 'No pending milestones to remind students about' });
			return;
		}

		if (team.students.length === 0) {
			res.status(400).json({ message: 'This team has no students to email' });
			return;
		}

		const milestones = pending.map((m) => ({ title: m.title, description: m.description, dueDate: m.dueDate }));

		const results = await Promise.allSettled(
			team.students.map((s) => sendDeadlineReminderEmail(s.email, s.name, team.name, milestones)),
		);

		const studentsEmailed = results.filter((r) => r.status === 'fulfilled').length;
		const failed = results.length - studentsEmailed;

		res.json({ ok: true, result: { studentsEmailed, failed, milestonesIncluded: pending.length } });
	} catch (error) {
		res.status(500).json({ message: 'Server error', error: errorMessage(error) });
	}
};

// GET /teams/:teamId/students/:studentId/activity
// This student's own commits/PRs/document edits, most recent first — used by
// the student detail page to show their real repo/doc activity rather than
// the whole team's feed.
export const getTeamStudentActivity = async (req: AuthRequest, res: Response): Promise<void> => {
	try {
		const team = await verifyTeamOwnership(req.params.teamId, req.teacher?.id);
		if (!team) {
			res.status(404).json({ message: 'Team not found' });
			return;
		}

		const student = team.students.id(req.params.studentId);
		if (!student) {
			res.status(404).json({ message: 'Student not found' });
			return;
		}

		const logs = await ActivityLog.find({
			teamId: team._id,
			studentEmail: student.email.toLowerCase(),
		})
			.sort({ timestamp: -1 })
			.limit(500);

		res.json(logs);
	} catch (error) {
		res.status(500).json({ message: 'Server error', error: errorMessage(error) });
	}
};

// Per-team milestone completion toggle. Title/description/dueDate are
// managed course-wide (see courseController) — this only ever touches
// `completed` for this one team's copy.
export const updateTeamMilestone = async (req: AuthRequest, res: Response): Promise<void> => {
	try {
		const team = await verifyTeamOwnership(req.params.teamId, req.teacher?.id);
		if (!team) {
			res.status(404).json({ message: 'Team not found' });
			return;
		}

		const milestone = team.milestones.id(req.params.milestoneId);
		if (!milestone) {
			res.status(404).json({ message: 'Milestone not found' });
			return;
		}

		if (typeof req.body.completed === 'boolean') milestone.completed = req.body.completed;
		await team.save();
		res.json(milestone);
	} catch (error) {
		res.status(500).json({ message: 'Server error', error: errorMessage(error) });
	}
};

export const deleteTeamStudent = async (req: AuthRequest, res: Response): Promise<void> => {
	try {
		const team = await verifyTeamOwnership(req.params.teamId, req.teacher?.id);
		if (!team) {
			res.status(404).json({ message: 'Team not found' });
			return;
		}

		const student = team.students.id(req.params.studentId);
		if (!student) {
			res.status(404).json({ message: 'Student not found' });
			return;
		}

		// Capture before removing
		const { githubUsername, email } = student;

		team.students = team.students.filter((s) => s._id.toString() !== req.params.studentId) as typeof team.students;
		await team.save();

		// Auto-remove from GitHub
		if (team.githubOwner && team.githubRepoName && githubUsername) {
			removeCollaborator(team.githubOwner, team.githubRepoName, githubUsername).catch(() => {});
		}

		// Auto-remove from Google Drive
		if (team.googleDriveFolder) {
			const folderId = parseGoogleFileId(team.googleDriveFolder);
			if (folderId) removeDriveMember(folderId, email).catch(() => {});
		}

		res.json({ message: 'Student removed' });
	} catch (error) {
		res.status(500).json({ message: 'Server error', error: errorMessage(error) });
	}
};
