/**
 * reMarkable cloud client (PRD F4, F7, K4, N3).
 *
 * Implements the device-token flow against the official cloud endpoints, with every host configurable so a self-hosted rmfakecloud
 * can take over unchanged (F7). The API is not officially documented and has
 * changed before (rmapi breakage, PRD §7): all calls go through the injected
 * HttpClient, errors surface as actionable TransportError messages, and no
 * response shape is trusted blindly.
 *
 * Notebooks themselves travel over the sync API (transport/notebook.ts).
 */

import { HttpClient, TransportError } from "./http";

export interface CloudEndpoints {
	/** Token host (registration + user token). */
	authHost: string;
	/** Document host (upload). */
	docHost: string;
}

export const OFFICIAL_ENDPOINTS: CloudEndpoints = {
	authHost: "https://webapp-prod.cloud.remarkable.engineering",
	docHost: "https://internal.cloud.remarkable.com",
};

/** rmfakecloud serves auth and docs from one base URL (F7). */
export function rmfakecloudEndpoints(baseUrl: string): CloudEndpoints {
	const trimmed = baseUrl.replace(/\/+$/, "");
	return { authHost: trimmed, docHost: trimmed };
}

export interface DeviceRegistration {
	deviceToken: string;
	deviceId: string;
}

export interface UploadResult {
	/** Document UUID assigned by the cloud. */
	deviceDocId: string;
	/** Content hash, when the endpoint reports one. */
	hash?: string;
}

interface CloudClientDeps {
	http: HttpClient;
	endpoints?: CloudEndpoints;
	/** Persisted device token (empty when not yet registered). */
	deviceToken?: string;
	generateDeviceId?: () => string;
}

export class RemarkableCloudClient {
	private readonly http: HttpClient;
	private readonly endpoints: CloudEndpoints;
	private deviceToken: string;
	private userToken: string | null = null;
	private readonly generateDeviceId: () => string;

	constructor(deps: CloudClientDeps) {
		this.http = deps.http;
		this.endpoints = deps.endpoints ?? OFFICIAL_ENDPOINTS;
		this.deviceToken = deps.deviceToken ?? "";
		this.generateDeviceId = deps.generateDeviceId ?? (() => crypto.randomUUID());
	}

	get isRegistered(): boolean {
		return this.deviceToken !== "";
	}

	/**
	 * Exchange a one-time pairing code (my.remarkable.com → "pair a browser")
	 * for a long-lived device token. The caller persists the returned token.
	 */
	async register(oneTimeCode: string): Promise<DeviceRegistration> {
		const code = oneTimeCode.trim().toLowerCase();
		if (!/^[a-z]{8}$/.test(code)) {
			throw new TransportError(
				"Pairing code must be the 8-letter code from my.remarkable.com/device/browser/connect.",
			);
		}
		const deviceId = this.generateDeviceId();
		const response = await this.http({
			url: `${this.endpoints.authHost}/token/json/2/device/new`,
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				code,
				deviceDesc: "browser-chrome",
				deviceID: deviceId,
			}),
		});
		if (response.status !== 200 || response.text.trim() === "") {
			throw new TransportError(
				response.status === 400 || response.status === 401
					? "Pairing code was rejected — codes expire quickly, generate a fresh one and try again."
					: `Device registration failed (HTTP ${response.status}).`,
				response.status,
			);
		}
		this.deviceToken = response.text.trim();
		this.userToken = null;
		return { deviceToken: this.deviceToken, deviceId };
	}

	/** Refresh the short-lived user token from the device token. */
	private async ensureUserToken(): Promise<string> {
		if (this.userToken !== null) return this.userToken;
		if (!this.isRegistered) {
			throw new TransportError(
				"Not connected to a reMarkable account yet — pair the plugin in the settings first.",
			);
		}
		const response = await this.http({
			url: `${this.endpoints.authHost}/token/json/2/user/new`,
			method: "POST",
			headers: { Authorization: `Bearer ${this.deviceToken}` },
		});
		if (response.status !== 200 || response.text.trim() === "") {
			throw new TransportError(
				response.status === 401
					? "The stored device token is no longer valid — re-pair the plugin in the settings."
					: `Could not refresh the session token (HTTP ${response.status}).`,
				response.status,
			);
		}
		this.userToken = response.text.trim();
		return this.userToken;
	}
}
