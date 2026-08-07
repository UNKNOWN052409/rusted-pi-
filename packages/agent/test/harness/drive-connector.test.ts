import { describe, expect, it } from "vitest";
import { DriveConnector, exchangeToken } from "../../src/drive-connector.ts";

interface StubFetchRoute {
	method: string;
	url: string;
	status: number;
	body: string;
}

/** Minimal in-memory fetch stand-in for the Google Drive API. */
type RequestInfoOrUrl = string | URL;

function stubFetch(routes: StubFetchRoute[]): typeof fetch {
	return (async (input: RequestInfoOrUrl, init?: RequestInit) => {
		const url = String(input);
		const method = (init?.method ?? "GET").toUpperCase();
		const route = routes.find((r) => r.method === method && url.includes(r.url));
		if (!route) {
			return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
		}
		return new Response(route.body, { status: route.status, headers: { "Content-Type": "application/json" } });
	}) as typeof fetch;
}

const credentials = {
	clientId: "test-client",
	clientSecret: "test-secret",
	refreshToken: "test-refresh",
};

describe("DriveConnector: custom Google Drive connector (no rclone)", () => {
	it("exchanges the refresh token for an access token", async () => {
		const token = await exchangeToken(credentials, {
			tokenEndpoint: "https://test.local/token",
			fetchImpl: stubFetch([
				{
					method: "POST",
					url: "/token",
					status: 200,
					body: JSON.stringify({ access_token: "abc123" }),
				},
			]),
		});
		expect(token).toBe("abc123");
	});

	it("fails clearly when the token endpoint rejects", async () => {
		await expect(
			exchangeToken(credentials, {
				tokenEndpoint: "https://test.local/token",
				fetchImpl: stubFetch([
					{
						method: "POST",
						url: "/token",
						status: 401,
						body: JSON.stringify({ error: "invalid_grant" }),
					},
				]),
			}),
		).rejects.toThrow(/Drive auth failed/);
	});

	it("uploads a checkpoint and finds it by name", async () => {
		const uploadRoutes: StubFetchRoute[] = [
			{ method: "POST", url: "/token", status: 200, body: JSON.stringify({ access_token: "tok" }) },
			{
				method: "GET",
				url: "/files?q=",
				status: 200,
				body: JSON.stringify({ files: [] }),
			},
			{
				method: "POST",
				url: "/files?uploadType=multipart",
				status: 200,
				body: JSON.stringify({ id: "file-1", name: "checkpoint.json", mimeType: "application/json" }),
			},
		];
		const connector = new DriveConnector({
			credentials,
			tokenEndpoint: "https://test.local/token",
			apiBase: "https://test.local/drive",
			fetchImpl: stubFetch(uploadRoutes),
		});
		const file = await connector.upload("checkpoint.json", '{"done":true}');
		expect(file.id).toBe("file-1");
		expect(file.name).toBe("checkpoint.json");
	});

	it("downloads a checkpoint by name", async () => {
		const routes: StubFetchRoute[] = [
			{ method: "POST", url: "/token", status: 200, body: JSON.stringify({ access_token: "tok" }) },
			{
				method: "GET",
				url: "/files?q=",
				status: 200,
				body: JSON.stringify({ files: [{ id: "file-1", name: "cp.json" }] }),
			},
			{
				method: "GET",
				url: "/files/file-1?alt=media",
				status: 200,
				body: '{"saved":true}',
			},
		];
		const connector = new DriveConnector({
			credentials,
			tokenEndpoint: "https://test.local/token",
			apiBase: "https://test.local/drive",
			fetchImpl: stubFetch(routes),
		});
		const content = await connector.download("cp.json");
		expect(content).toBe('{"saved":true}');
	});

	it("returns undefined when downloading a missing checkpoint", async () => {
		const routes: StubFetchRoute[] = [
			{ method: "POST", url: "/token", status: 200, body: JSON.stringify({ access_token: "tok" }) },
			{ method: "GET", url: "/files?q=", status: 200, body: JSON.stringify({ files: [] }) },
		];
		const connector = new DriveConnector({
			credentials,
			tokenEndpoint: "https://test.local/token",
			apiBase: "https://test.local/drive",
			fetchImpl: stubFetch(routes),
		});
		await expect(connector.download("missing.json")).resolves.toBeUndefined();
	});
});
