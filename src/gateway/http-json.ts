export function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

export async function body<T>(request: Request): Promise<T> {
  return (await request.json()) as T;
}
