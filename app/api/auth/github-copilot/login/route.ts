import { copilotAuthResponse, copilotLogin } from "@/src/server";

export async function POST(request: Request) {
	return copilotAuthResponse(request, () => copilotLogin.start());
}
