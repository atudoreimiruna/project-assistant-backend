import { Response } from 'express';
import { errorMessage } from '../utils/errors';
import Course from '../models/Course';
import Team from '../models/Team';
import { AuthRequest } from '../middlewares/auth';

export const createCourse = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const course = await Course.create({
      ...req.body,
      teacherId: req.teacher?.id,
    });
    res.status(201).json(course);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: errorMessage(error) });
  }
};

export const getCourses = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const courses = await Course.find({ teacherId: req.teacher?.id });
    res.json(courses);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: errorMessage(error) });
  }
};

export const getCourse = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const course = await Course.findOne({
      _id: req.params.id,
      teacherId: req.teacher?.id,
    });
    if (!course) {
      res.status(404).json({ message: 'Course not found' });
      return;
    }
    res.json(course);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: errorMessage(error) });
  }
};

export const deleteCourse = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const course = await Course.findOneAndDelete({
      _id: req.params.id,
      teacherId: req.teacher?.id,
    });
    if (!course) {
      res.status(404).json({ message: 'Course not found' });
      return;
    }
    res.json({ message: 'Course deleted' });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: errorMessage(error) });
  }
};

/*
 * Course-wide milestones: created/edited/deleted once by the teacher here on
 * the course, then cascaded into a linked copy (`courseMilestoneId`) on every
 * team in the course. Each team tracks its own `completed` flag on its copy
 * independently (see teamController#updateTeamMilestone) — everything else
 * (title/description/dueDate) stays in sync across teams from this file.
 */

export const createCourseMilestone = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const course = await Course.findOne({ _id: req.params.courseId, teacherId: req.teacher?.id });
    if (!course) {
      res.status(404).json({ message: 'Course not found' });
      return;
    }

    const { title, description, dueDate } = req.body;
    if (!title || !dueDate) {
      res.status(400).json({ message: 'title and dueDate are required' });
      return;
    }

    course.milestones.push({ title, description, dueDate });
    await course.save();
    const milestone = course.milestones[course.milestones.length - 1];

    const teams = await Team.find({ courseId: course._id });
    await Promise.all(
      teams.map((team) => {
        team.milestones.push({ title, description, dueDate, completed: false, courseMilestoneId: milestone._id });
        return team.save();
      }),
    );

    res.status(201).json(milestone);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: errorMessage(error) });
  }
};

export const updateCourseMilestone = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const course = await Course.findOne({ _id: req.params.courseId, teacherId: req.teacher?.id });
    if (!course) {
      res.status(404).json({ message: 'Course not found' });
      return;
    }

    const milestone = course.milestones.id(req.params.milestoneId);
    if (!milestone) {
      res.status(404).json({ message: 'Milestone not found' });
      return;
    }

    const { title, description, dueDate } = req.body;
    if (title !== undefined) milestone.title = title;
    if (description !== undefined) milestone.description = description;
    if (dueDate !== undefined) milestone.dueDate = dueDate;
    await course.save();

    // Propagate to every linked copy across teams — each team's own
    // `completed` flag is left untouched.
    const teams = await Team.find({ courseId: course._id, 'milestones.courseMilestoneId': milestone._id });
    await Promise.all(
      teams.map((team) => {
        for (const m of team.milestones) {
          if (m.courseMilestoneId?.toString() === milestone._id.toString()) {
            if (title !== undefined) m.title = title;
            if (description !== undefined) m.description = description;
            if (dueDate !== undefined) m.dueDate = dueDate;
          }
        }
        return team.save();
      }),
    );

    res.json(milestone);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: errorMessage(error) });
  }
};

export const deleteCourseMilestone = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const course = await Course.findOne({ _id: req.params.courseId, teacherId: req.teacher?.id });
    if (!course) {
      res.status(404).json({ message: 'Course not found' });
      return;
    }

    const milestone = course.milestones.id(req.params.milestoneId);
    if (!milestone) {
      res.status(404).json({ message: 'Milestone not found' });
      return;
    }

    course.milestones = course.milestones.filter(
      (m) => m._id.toString() !== req.params.milestoneId,
    ) as typeof course.milestones;
    await course.save();

    const teams = await Team.find({ courseId: course._id, 'milestones.courseMilestoneId': req.params.milestoneId });
    await Promise.all(
      teams.map((team) => {
        team.milestones = team.milestones.filter(
          (m) => m.courseMilestoneId?.toString() !== req.params.milestoneId,
        ) as typeof team.milestones;
        return team.save();
      }),
    );

    res.json({ message: 'Milestone deleted' });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: errorMessage(error) });
  }
};
