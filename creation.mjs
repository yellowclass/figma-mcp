export class CreationError extends Error {}
const filePattern = /^[A-Za-z0-9]{22,128}$/;
export const validDestination = (d) =>
  !!d &&
  typeof d === "object" &&
  typeof d.planKey === "string" &&
  typeof d.projectId === "string" &&
  /^(team|organization)::\d+$/.test(d.planKey) &&
  /^\d+$/.test(d.projectId);
export const creationTool = {
  name: "create_new_file",
  description:
    "Create a Figma Design file in this organisation’s approved destination. Use a stable requestId for retries of the same task. Never change the ID to retry an ambiguous failure without inspecting the destination first. The server chooses the team and folder.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["fileName", "requestId"],
    properties: {
      fileName: { type: "string", minLength: 1, maxLength: 200 },
      requestId: { type: "string", pattern: "^[A-Za-z0-9_-]{8,128}$" },
    },
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: false,
  },
};
export function extractCreatedKey(result) {
  const keys = new Set();
  function inspect(d) {
    if (!d || typeof d !== "object") return;
    for (const k of ["fileKey", "file_key"])
      if (typeof d[k] === "string" && filePattern.test(d[k])) keys.add(d[k]);
    for (const k of ["fileUrl", "file_url", "url"])
      if (typeof d[k] === "string") inspectText(d[k]);
  }
  function inspectText(text) {
    for (const m of text.matchAll(
      /https:\/\/(?:www\.)?figma\.com\/(?:design|file|board|slides)\/([A-Za-z0-9]{22,128})(?=[/?#\s)"']|$)/g,
    ))
      keys.add(m[1]);
  }
  inspect(result.structuredContent);
  for (const c of result.content ?? [])
    if (c.type === "text") {
      try {
        inspect(JSON.parse(c.text));
      } catch {}
      inspectText(c.text);
    }
  if (keys.size !== 1)
    throw new CreationError(
      "Figma created a file but its identity is ambiguous; inspect the destination before retrying",
    );
  return [...keys][0];
}
export function fileCreator(core, slug, token) {
  return async (args, invoke) => {
    if (
      !args ||
      Object.keys(args).some((k) => !["fileName", "requestId"].includes(k)) ||
      typeof args.fileName !== "string" ||
      !args.fileName.trim() ||
      args.fileName.length > 200 ||
      typeof args.requestId !== "string" ||
      !/^[A-Za-z0-9_-]{8,128}$/.test(args.requestId)
    )
      throw new CreationError(
        "Provide a file name and stable requestId; destination overrides are not allowed",
      );
    const reservation = await core.creation(slug, token, {
      requestId: args.requestId,
    });
    if (reservation.fileKey && filePattern.test(reservation.fileKey))
      return response(reservation.fileKey);
    if (!validDestination(reservation.destination))
      throw new CreationError("No approved creation destination");
    let result;
    try {
      result = await invoke({
        name: "create_new_file",
        arguments: {
          fileName: args.fileName.trim(),
          editorType: "design",
          planKey: reservation.destination.planKey,
          projectId: reservation.destination.projectId,
        },
      });
    } catch {
      throw new CreationError(
        "Figma creation did not finish. Inspect the destination before retrying; preserve requestId " +
          args.requestId,
      );
    }
    if (result.isError)
      throw new CreationError(
        "Figma rejected file creation. Verify the shared account has a Full seat and folder edit access; inspect the destination before retrying.",
      );
    const key = extractCreatedKey(result);
    await core.creation(slug, token, {
      requestId: args.requestId,
      fileKey: key,
    });
    return response(key);
  };
}
function response(key) {
  return {
    structuredContent: {
      fileKey: key,
      fileUrl: `https://www.figma.com/design/${key}`,
    },
    content: [
      {
        type: "text",
        text: JSON.stringify({
          fileKey: key,
          fileUrl: `https://www.figma.com/design/${key}`,
        }),
      },
    ],
  };
}
