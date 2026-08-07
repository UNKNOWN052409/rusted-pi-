/**
 * Custom Google Drive connector (no rclone).
 *
 * Implements the minimal Google Drive API surface needed to back up and
 * restore checkpoints/sessions: an OAuth2 token endpoint, a files.list
 * search, a files.get for download, and a files.upload for backup. The
 * transport is plain fetch, so it works on low-end devices (Raspberry Pi,
 * Termux on a Realme C15) and can run fully offline from any HTTP client.
 *
 * The user asked for a self-built connector instead of rclone because rclone
 * is hard to install/configure on constrained devices; this one is a single
 * module with no dependencies beyond the platform fetch.
 */

export interface DriveCredentials {
	/** OAuth2 client id. */
	clientId: string;
	/** OAuth2 client secret. */
	clientSecret: string;
	/** Refresh token (already obtained via the device flow). */
	refreshToken: string;
}

export interface DriveFile {
	id: string;
	name: string;
	mimeType: string;
	size?: number;
	modifiedTime?: string;
}

export interface DriveConnectorOptions {
	credentials: DriveCredentials;
	/** Custom fetch implementation (defaults to globalThis.fetch). */
	fetchImpl?: typeof fetch;
	/** Custom token endpoint (defaults to Google's). */
	tokenEndpoint?: string;
	/** Custom API base (defaults to Google Drive v3). */
	apiBase?: string;
	/** App name for the upload metadata. */
	appName?: string;
}

const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const DRIVE_API_BASE = "https://www.googleapis.com/drive/v3";

export class DriveConnector {
	private readonly credentials: DriveCredentials;
	private readonly fetchImpl: typeof fetch;
	private readonly tokenEndpoint: string;
	private readonly apiBase: string;
	private readonly appName: string;
	private accessToken: string | null = null;

	constructor(options: DriveConnectorOptions) {
		this.credentials = options.credentials;
		this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
		this.tokenEndpoint = options.tokenEndpoint ?? GOOGLE_TOKEN_ENDPOINT;
		this.apiBase = options.apiBase ?? DRIVE_API_BASE;
		this.appName = options.appName ?? "pi-agent";
	}

	/** Exchange the refresh token for an access token (cached). */
	async authenticate(): Promise<string> {
		if (this.accessToken) return this.accessToken;
		const response = await this.fetchImpl(this.tokenEndpoint, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				client_id: this.credentials.clientId,
				client_secret: this.credentials.clientSecret,
				refresh_token: this.credentials.refreshToken,
				grant_type: "refresh_token",
			}).toString(),
		});
		if (!response.ok) {
			throw new Error(`Drive auth failed: ${response.status} ${await response.text()}`);
		}
		const body = (await response.json()) as { access_token?: string };
		if (!body.access_token) {
			throw new Error("Drive auth failed: no access_token in response");
		}
		this.accessToken = body.access_token;
		return this.accessToken;
	}

	private async request(path: string, init?: RequestInit): Promise<Response> {
		const token = await this.authenticate();
		return this.fetchImpl(`${this.apiBase}${path}`, {
			...init,
			headers: { Authorization: `Bearer ${token}`, ...(init?.headers ?? {}) },
		});
	}

	/** Upload (or overwrite) a checkpoint under a stable name. */
	async upload(name: string, content: string, mimeType = "application/json"): Promise<DriveFile> {
		const existing = await this.findByName(name);
		const body = new FormData();
		const metadata = JSON.stringify({ name, mimeType, description: `checkpoint by ${this.appName}` });
		body.append("metadata", new Blob([metadata], { type: "application/json" }));
		body.append("file", new Blob([content], { type: mimeType }), name);
		const response = await this.request(
			existing ? `/files/${existing.id}?uploadType=multipart` : "/files?uploadType=multipart",
			{ method: existing ? "PATCH" : "POST", body },
		);
		if (!response.ok) {
			throw new Error(`Drive upload failed: ${response.status} ${await response.text()}`);
		}
		return (await response.json()) as DriveFile;
	}

	/** Download a checkpoint by name (or undefined when it does not exist). */
	async download(name: string): Promise<string | undefined> {
		const file = await this.findByName(name);
		if (!file) return undefined;
		const response = await this.request(`/files/${file.id}?alt=media`);
		if (!response.ok) {
			throw new Error(`Drive download failed: ${response.status} ${await response.text()}`);
		}
		return response.text();
	}

	/** Find a file by exact name via files.list. */
	async findByName(name: string): Promise<DriveFile | undefined> {
		const query = encodeURIComponent(`name = '${name.replace(/'/g, "\\'")}' and trashed = false`);
		const response = await this.request(`/files?q=${query}&fields=files(id,name,mimeType,size,modifiedTime)`);
		if (!response.ok) {
			throw new Error(`Drive search failed: ${response.status} ${await response.text()}`);
		}
		const body = (await response.json()) as { files?: DriveFile[] };
		return body.files?.[0];
	}

	/** Delete a checkpoint by name (returns false when it did not exist). */
	async deleteByName(name: string): Promise<boolean> {
		const file = await this.findByName(name);
		if (!file) return false;
		const response = await this.request(`/files/${file.id}`, { method: "DELETE" });
		if (!response.ok) {
			throw new Error(`Drive delete failed: ${response.status} ${await response.text()}`);
		}
		return true;
	}
}

/** Token probe used by tests: exchanges a stand-in refresh token against a local test endpoint. */
export async function exchangeToken(
	credentials: DriveCredentials,
	options?: { fetchImpl?: typeof fetch; tokenEndpoint?: string },
): Promise<string> {
	const connector = new DriveConnector({ credentials, ...options });
	return connector.authenticate();
}
