# AI Project Management Assistant — Backend

Node.js + TypeScript backend for the university teacher AI agent.

## Stack
- **Runtime**: Node.js + TypeScript
- **Framework**: Express
- **Database**: MongoDB (via Mongoose)
- **AI**: Anthropic Claude API
- **Auth**: JWT + bcrypt

## Project Structure

```
src/
├── agents/          # AI agent logic (Claude API calls)
│   └── progressAgent.ts
├── config/          # DB connection
│   └── db.ts
├── controllers/     # Route handlers
│   ├── authController.ts
│   ├── courseController.ts
│   └── teamController.ts
├── middlewares/     # JWT auth middleware
│   └── auth.ts
├── models/          # Mongoose schemas
│   ├── Teacher.ts
│   ├── Course.ts
│   ├── Team.ts
│   └── ActivityLog.ts
├── routes/          # API routes
│   └── index.ts
├── types/           # TypeScript interfaces
│   └── index.ts
└── index.ts         # App entry point
```

## Setup

```bash
# Install dependencies
npm install

# Copy and fill in environment variables
cp .env.example .env

# Run in development mode
npm run dev

# Build for production
npm run build
npm start
```

## API Endpoints

### Auth
| Method | Path | Description |
|--------|------|-------------|
| POST | /api/auth/register | Register a teacher |
| POST | /api/auth/login | Login |

### Courses
| Method | Path | Description |
|--------|------|-------------|
| GET | /api/courses | List teacher's courses |
| POST | /api/courses | Create a course |
| GET | /api/courses/:id | Get a course |
| DELETE | /api/courses/:id | Delete a course |

### Teams
| Method | Path | Description |
|--------|------|-------------|
| GET | /api/courses/:courseId/teams | List teams in a course |
| POST | /api/courses/:courseId/teams | Create a team |
| GET | /api/teams/:id | Get a team |
| PUT | /api/teams/:id | Update a team |

### Activity Logs
| Method | Path | Description |
|--------|------|-------------|
| POST | /api/teams/:teamId/activity | Log an activity |
| GET | /api/teams/:teamId/activity | Get team activity |

### AI Agent
| Method | Path | Description |
|--------|------|-------------|
| GET | /api/teams/:teamId/report | Generate AI progress report |
| POST | /api/courses/:courseId/ask | Ask the AI a natural language question |
