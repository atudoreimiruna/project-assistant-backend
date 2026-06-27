import { Response } from 'express';
import Course from '../models/Course';
import { AuthRequest } from '../middlewares/auth';

export const createCourse = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const course = await Course.create({
      ...req.body,
      teacherId: req.teacher?.id,
    });
    res.status(201).json(course);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error });
  }
};

export const getCourses = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const courses = await Course.find({ teacherId: req.teacher?.id });
    res.json(courses);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error });
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
    res.status(500).json({ message: 'Server error', error });
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
    res.status(500).json({ message: 'Server error', error });
  }
};
