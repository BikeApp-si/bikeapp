import { KernelError } from "@/server/kernel/context";

// A file sent to the browser. A kernel refusal is a plain 404, so nothing says what exists.
export function download(file: { name: string; mime: string; body: Uint8Array }, inline = false) {
  const name = encodeURIComponent(file.name);
  return new Response(file.body as BodyInit, {
    headers: {
      "content-type": file.mime,
      "content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${name}`,
      "x-content-type-options": "nosniff",
      "cache-control": "private, no-store",
    },
  });
}

export async function orNotFound(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof KernelError) return new Response("Not found", { status: 404 });
    throw e;
  }
}
