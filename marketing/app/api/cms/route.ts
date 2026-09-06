import { getCmsAdmin } from "../../../cms/auth";
import { mutateCms } from "../../../cms/mutations";
import { isSameOriginCmsRequest } from "../../../cms/request";



export async function POST(request: Request) {
  // Platform authentication identifies the editor, while this origin check
  // prevents another site from submitting that editor's ambient session.
  if (!isSameOriginCmsRequest(request, ["application/x-www-form-urlencoded", "multipart/form-data"])) return new Response("Forbidden", { status: 403 });
  const admin = await getCmsAdmin();
  if (!admin) return new Response("Not authorized", { status: 403 });

  const form = await request.formData();
  const result = await mutateCms(form);
  if ("error" in result) return new Response(result.error, { status: result.status });
  return Response.redirect(new URL(`/admin?notice=${result.notice}`, request.url), 303);
}
