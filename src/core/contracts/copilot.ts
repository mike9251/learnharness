/** Browser-safe Copilot auth views. Credentials never enter these DTOs. */
export interface CopilotStatus {
	connected: boolean;
}

export interface CopilotLoginStatus {
	id: string;
	state: "starting" | "waiting" | "connected" | "error" | "cancelled" | "expired";
	userCode?: string;
	verificationUri?: string;
	expiresAt?: number;
	error?: string;
}
