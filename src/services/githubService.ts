import Team from '../models/Team';

import ActivityLog from '../models/ActivityLog';

export interface ContributorPreview {
	name: string;
	email: string;
	githubUsername?: string;
	alreadyMember: boolean;

	possibleDuplicate?: string;

	hasRealEmail: boolean;

	source: 'github' | 'drive';

	editCount?: number;

	lastEditAt?: string;
}

export const parseRepoUrl = (repoUrl: string) => {

	try {
		if (repoUrl.startsWith('git@')) {

			const parts = repoUrl.split(':')[1].replace(/\.git$/, '');
			const [owner, repo] = parts.split('/');
			return { owner, repo };
		}

		const u = new URL(repoUrl);
		const parts = u.pathname
			.replace(/^\//, '')
			.replace(/\.git$/, '')
			.split('/');
		const [owner, repo] = parts;
		return { owner, repo };
	} catch (err) {
		return null;
	}
};

const getHeaders = () => {
	const headers: Record<string, string> = { Accept: 'application/vnd.github.v3+json' };
	const token = process.env.GITHUB_TOKEN?.trim();
	if (token && token.length > 10) headers['Authorization'] = `token ${token}`;
	return headers;
};

const isNoreplyEmail = (email: string | null | undefined): boolean =>
	!!email && /@users\.noreply\.github\.com$/i.test(email);

const resolveContributorProfile = async (
	owner: string,
	repo: string,
	login: string,
): Promise<{ name: string; email: string; hasRealEmail: boolean }> => {
	let name = login;
	let email = `${login}@users.noreply.github.com`;
	let hasRealEmail = false;

	const userRes = await fetch(`https://api.github.com/users/${login}`, { headers: getHeaders() });
	if (userRes.ok) {
		const user = await userRes.json() as any;
		if (user.name) name = user.name;
		if (user.email && !isNoreplyEmail(user.email)) {
			email = user.email;
			hasRealEmail = true;
		}
	}

	if (!hasRealEmail) {
		try {
			const commitsRes = await fetch(
				`https://api.github.com/repos/${owner}/${repo}/commits?author=${login}&per_page=5`,
				{ headers: getHeaders() },
			);
			if (commitsRes.ok) {
				const commits = await commitsRes.json() as any[];
				if (Array.isArray(commits)) {
					const realEmailCommit = commits.find(
						(c: any) => c.commit?.author?.email && !isNoreplyEmail(c.commit.author.email),
					);
					if (realEmailCommit) {
						email = realEmailCommit.commit.author.email;
						hasRealEmail = true;
					}
				}
			}
		} catch {

		}
	}

	return { name, email, hasRealEmail };
};

export const syncTeamRepo = async (teamId: string) => {
	const team = await Team.findById(teamId);
	if (!team) throw new Error('Team not found');

	let repo: { owner: string; repo: string } | null = null;

	if (team.githubOwner && team.githubRepoName) {
		repo = { owner: team.githubOwner, repo: team.githubRepoName };
	} else if (team.githubRepo) {
		repo = parseRepoUrl(team.githubRepo);
	}

	if (!repo) throw new Error('No valid GitHub repo on this team');

	const studentEmails = new Set((team.students || []).map((s: any) => s.email.toLowerCase()));

	const usernameToEmail = new Map<string, string>(
		(team.students || [])
			.filter((s: any) => s.githubUsername)
			.map((s: any) => [s.githubUsername.toLowerCase(), s.email.toLowerCase()]),
	);

	const resolveStudentEmail = (login: string | undefined, email: string | undefined): string | undefined => {
		const byLogin = login && usernameToEmail.get(login.toLowerCase());
		if (byLogin) return byLogin;
		const lowerEmail = email?.toLowerCase();
		return lowerEmail && studentEmails.has(lowerEmail) ? lowerEmail : undefined;
	};

	const sinceDate = new Date(Date.now() - 1000 * 60 * 60 * 24 * 30).toISOString(); // last 30 days

	const commitsRes = await fetch(`https://api.github.com/repos/${repo.owner}/${repo.repo}/commits?since=${sinceDate}&per_page=100`, { headers: getHeaders() });
	if (!commitsRes.ok) {
		const errBody = await commitsRes.json().catch(() => ({}));
		throw new Error(`Failed fetching commits: ${commitsRes.status} - ${(errBody as any).message || ''}`);
	}
	const commits = await commitsRes.json() as any[];
	if (!Array.isArray(commits)) throw new Error(`Unexpected commits response: ${JSON.stringify(commits)}`);

	for (const c of commits) {
		const ghId = c.sha;
		const studentEmail = resolveStudentEmail(c.author?.login, c.commit?.author?.email);

		const exists = await ActivityLog.findOne({ 'metadata.githubId': ghId });
		if (exists) {

			if (studentEmail && exists.studentEmail !== studentEmail) {
				exists.studentEmail = studentEmail;
				await exists.save();
			}
			continue;
		}

		const description = `Commit ${ghId} by ${c.commit?.author?.name || c.author?.login || 'unknown'}: ${c.commit?.message?.split('\n')[0]}`;

		await ActivityLog.create({
			teamId,
			type: 'commit',
			studentEmail,
			description,
			timestamp: new Date(c.commit?.author?.date || Date.now()),
			metadata: { githubId: ghId, url: c.html_url, githubLogin: c.author?.login },
		});
	}

	const prsRes = await fetch(`https://api.github.com/repos/${repo.owner}/${repo.repo}/pulls?state=all&sort=updated&direction=desc&per_page=100`, { headers: getHeaders() });
	if (!prsRes.ok) {
		const errBody = await prsRes.json().catch(() => ({}));
		throw new Error(`Failed fetching PRs: ${prsRes.status} - ${(errBody as any).message || ''}`);
	}
	const prs = await prsRes.json() as any[];
	if (!Array.isArray(prs)) throw new Error(`Unexpected PRs response: ${JSON.stringify(prs)}`);

	for (const p of prs) {
		const ghId = `pr-${p.number}`;

		const studentEmail = resolveStudentEmail(p.user?.login, p.user?.email);

		const exists = await ActivityLog.findOne({ 'metadata.githubId': ghId });
		if (exists) {

			if (studentEmail && exists.studentEmail !== studentEmail) {
				exists.studentEmail = studentEmail;
				await exists.save();
			}
			continue;
		}

		const description = `PR #${p.number} ${p.title} by ${p.user?.login}`;

		await ActivityLog.create({
			teamId,
			type: 'pr',
			studentEmail,
			description,
			timestamp: new Date(p.updated_at || Date.now()),
			metadata: { githubId: ghId, url: p.html_url, state: p.state, githubLogin: p.user?.login },
		});
	}

	return { commits: commits.length, prs: prs.length };
};

export const addCollaborator = async (owner: string, repo: string, username: string): Promise<void> => {
	const res = await fetch(
		`https://api.github.com/repos/${owner}/${repo}/collaborators/${username}`,
		{ method: 'PUT', headers: { ...getHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ permission: 'push' }) },
	);
	if (res.status !== 201 && res.status !== 204) {
		const body = await res.json().catch(() => ({}));
		throw new Error(`GitHub add collaborator failed: ${res.status} - ${(body as any).message || ''}`);
	}
};

export const removeCollaborator = async (owner: string, repo: string, username: string): Promise<void> => {
	const res = await fetch(
		`https://api.github.com/repos/${owner}/${repo}/collaborators/${username}`,
		{ method: 'DELETE', headers: getHeaders() },
	);
	if (res.status !== 204) {
		const body = await res.json().catch(() => ({}));
		throw new Error(`GitHub remove collaborator failed: ${res.status} - ${(body as any).message || ''}`);
	}
};

export const previewGithubContributors = async (teamId: string): Promise<ContributorPreview[]> => {
	const team = await Team.findById(teamId);
	if (!team || !team.githubOwner || !team.githubRepoName) return [];
	const { githubOwner: owner, githubRepoName: repo } = team;

	const res = await fetch(
		`https://api.github.com/repos/${owner}/${repo}/contributors?per_page=100`,
		{ headers: getHeaders() },
	);
	if (!res.ok) return [];

	const contributors = await res.json() as any[];
	if (!Array.isArray(contributors)) return [];

	const existingEmails = new Set(team.students.map((s: any) => s.email.toLowerCase()));
	const existingUsernames = new Set(
		team.students.filter((s: any) => s.githubUsername).map((s: any) => (s.githubUsername as string).toLowerCase()),
	);

	const existingNames = team.students.map((s: any) => ({ name: (s.name as string).toLowerCase(), display: s.name as string }));

	const previews: ContributorPreview[] = [];

	for (const contributor of contributors) {
		const login: string = contributor.login;
		if (!login || contributor.type === 'Bot') continue;

		const { name, email, hasRealEmail } = await resolveContributorProfile(owner, repo, login);

		const alreadyMember =
			existingUsernames.has(login.toLowerCase()) ||
			existingEmails.has(email.toLowerCase());

		let possibleDuplicate: string | undefined;
		if (!alreadyMember) {
			const lowerName = name.toLowerCase();
			const match = existingNames.find((e) => e.name === lowerName);
			if (match) possibleDuplicate = match.display;
		}

		previews.push({ name, email, githubUsername: login, alreadyMember, possibleDuplicate, hasRealEmail, source: 'github' });
	}

	return previews;
};

export const importGithubContributors = async (teamId: string): Promise<void> => {
	const team = await Team.findById(teamId);
	if (!team || !team.githubOwner || !team.githubRepoName) return;
	const { githubOwner: owner, githubRepoName: repo } = team;

	const res = await fetch(
		`https://api.github.com/repos/${owner}/${repo}/contributors?per_page=100`,
		{ headers: getHeaders() },
	);
	if (!res.ok) return; // silently skip (e.g. private repo with no token)

	const contributors = await res.json() as any[];
	if (!Array.isArray(contributors)) return;

	const existingUsernames = new Set(
		team.students
			.filter((s: any) => s.githubUsername)
			.map((s: any) => (s.githubUsername as string).toLowerCase()),
	);

	for (const contributor of contributors) {
		const login: string = contributor.login;
		if (!login || contributor.type === 'Bot') continue;
		if (existingUsernames.has(login.toLowerCase())) continue;

		const { name, email } = await resolveContributorProfile(owner, repo, login);

		team.students.push({ name, email, githubUsername: login });
		existingUsernames.add(login.toLowerCase());
	}

	await team.save();
};

export const syncTeamCollaborators = async (teamId: string): Promise<void> => {
	const team = await Team.findById(teamId);
	if (!team || !team.githubOwner || !team.githubRepoName) return;
	const { githubOwner: owner, githubRepoName: repo } = team;

	await Promise.allSettled(
		team.students
			.filter((s: any) => s.githubUsername)
			.map((s: any) => addCollaborator(owner, repo, s.githubUsername!)),
	);
};

export default { syncTeamRepo, addCollaborator, removeCollaborator, syncTeamCollaborators };
