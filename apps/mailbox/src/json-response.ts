const bodiless = new Set([204, 205, 304]);

export const jsonResponse = (body: string, status: number) =>
  new Response(bodiless.has(status) ? null : body, {
    headers: { "content-type": "application/json" },
    status,
  });
