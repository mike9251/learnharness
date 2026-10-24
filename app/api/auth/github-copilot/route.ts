import { copilotAuthResponse, copilotLogin, copilotStatus } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
	return copilotAuthResponse(request, () => copilotStatus());
}

export async function DELETE(request: Request) {
	return copilotAuthResponse(request, async () => {
		await copilotLogin.disconnect();
		return copilotStatus();
	});
}
