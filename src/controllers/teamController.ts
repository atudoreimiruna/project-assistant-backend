import { Response } from 'express';
import Team from '../models/Team';
import Course from '../models/Course';
import { AuthRequest } from '../middlewares/auth';
import { parseRepoUrl, syncTeamRepo } from '../services/githubService';

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

		const team = await Team.create(body);

		if (team.githubOwner) {
			syncTeamRepo(team.id).catch(() => {}); // fire-and-forget
		}

		res.status(201).json(team);
	} catch (error) {
		res.status(500).json({ message: 'Server error', error });
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
		res.status(500).json({ message: 'Server error', error });
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
		res.status(500).json({ message: 'Server error', error });
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

		if (repoChanged) {
			const parsed = parseRepoUrl(req.body.githubRepo);
			if (!parsed) {
				res.status(400).json({ message: 'Invalid GitHub repo URL' });
				return;
			}
			req.body.githubOwner = parsed.owner;
			req.body.githubRepoName = parsed.repo;
		}

		Object.assign(team, req.body);
		await team.save();

		if (repoChanged) {
			syncTeamRepo(team.id).catch(() => {}); // fire-and-forget
		}

		res.json(team);
	} catch (error) {
		res.status(500).json({ message: 'Server error', error });
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
		res.status(500).json({ message: 'Server error', error });
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
		res.status(201).json(student);
	} catch (error) {
		res.status(500).json({ message: 'Server error', error });
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
		res.status(500).json({ message: 'Server error', error });
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
		res.status(500).json({ message: 'Server error', error });
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
		res.status(500).json({ message: 'Server error', error });
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

		team.students = team.students.filter((s) => s._id.toString() !== req.params.studentId) as typeof team.students;
		await team.save();
		res.json({ message: 'Student removed' });
	} catch (error) {
		res.status(500).json({ message: 'Server error', error });
	}
};
