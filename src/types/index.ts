export interface IStudent {
  name: string;
  email: string;
  githubUsername?: string;
}

export interface IMilestone {
  title: string;
  description: string;
  dueDate: Date;
  completed: boolean;
}

export interface JwtPayload {
  id: string;
  email: string;
}
