import { copilotAuthResponse, copilotLogin } from "@/src/server";

type Context = { params: Promise<{ id: string }> };
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: Context) {
	return copilotAuthResponse(request, async () => copilotLogin.status((await context.params).id));
}

export async function DELETE(request: Request, context: Context) {
	return copilotAuthResponse(request, async () => copilotLogin.cancel((await context.params).id));
}
