import { describe, expect, it } from "vitest";
import {
	OFFICIAL_ENDPOINTS,
	RemarkableCloudClient,
	rmfakecloudEndpoints,
} from "../transport/cloud";
import { HttpRequest, HttpResponse, TransportError } from "../transport/http";

function fakeHttp(handler: (req: HttpRequest) => Partial<HttpResponse>) {
	const calls: HttpRequest[] = [];
	const http = (req: HttpRequest): Promise<HttpResponse> => {
		calls.push(req);
		const partial = handler(req);
		return Promise.resolve({ status: 200, headers: {}, text: "", ...partial });
	};
	return { http, calls };
}

describe("register", () => {
	it("exchanges a pairing code for a device token", async () => {
		const { http, calls } = fakeHttp(() => ({ text: "device-token-jwt" }));
		const client = new RemarkableCloudClient({ http, generateDeviceId: () => "fixed-id" });
		const result = await client.register("ABCDEFGH");

		expect(result.deviceToken).toBe("device-token-jwt");
		expect(calls[0].url).toBe(`${OFFICIAL_ENDPOINTS.authHost}/token/json/2/device/new`);
		const body = JSON.parse(calls[0].body as string) as Record<string, string>;
		expect(body).toEqual({
			code: "abcdefgh",
			deviceDesc: "browser-chrome",
			deviceID: "fixed-id",
		});
		expect(client.isRegistered).toBe(true);
	});

	it("rejects malformed pairing codes before calling the network", async () => {
		const { http, calls } = fakeHttp(() => ({}));
		const client = new RemarkableCloudClient({ http });
		await expect(client.register("kort")).rejects.toThrow(TransportError);
		expect(calls).toHaveLength(0);
	});

	it("translates a rejected code into an actionable message", async () => {
		const { http } = fakeHttp(() => ({ status: 401 }));
		const client = new RemarkableCloudClient({ http });
		await expect(client.register("abcdefgh")).rejects.toThrow(/expire quickly/);
	});
});

describe("rmfakecloud endpoints", () => {
	it("routes auth and docs to one self-hosted base URL", async () => {
		const endpoints = rmfakecloudEndpoints("https://rm.example.org/");
		expect(endpoints).toEqual({
			authHost: "https://rm.example.org",
			docHost: "https://rm.example.org",
		});
		const { http, calls } = fakeHttp(() => ({ text: "device-token" }));
		const client = new RemarkableCloudClient({ http, endpoints });
		await client.register("abcdefgh");
		expect(calls.length).toBeGreaterThan(0);
		expect(calls.every((c) => c.url.startsWith("https://rm.example.org/"))).toBe(true);
	});
});
