// Accepts customer feedback. Self-contained on purpose: no PR branch touches it, and its answer is
// deterministic, so bdiff's API probe can exercise a non-GET endpoint the same way on base and head.
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'The body must be JSON.' }, { status: 400 });
  }
  const { message, rating } = (body ?? {}) as { message?: unknown; rating?: unknown };
  if (
    typeof message !== 'string' ||
    message.trim() === '' ||
    typeof rating !== 'number' ||
    !Number.isInteger(rating) ||
    rating < 1 ||
    rating > 5
  ) {
    return Response.json(
      { error: 'Send a non-empty "message" and a "rating" from 1 to 5.' },
      { status: 400 },
    );
  }
  return Response.json({ id: 'feedback-1', message: message.trim(), rating }, { status: 201 });
}
