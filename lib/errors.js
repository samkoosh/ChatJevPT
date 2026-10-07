// Maps a TypeSafe SDK error to the JSON response the browser understands.
export function jevErrorResponse(err) {
  console.error(err);
  if (isOutOfCredits(err)) {
    return Response.json(
      { error: "ChatJevPT is out of Jev credits, so it can't answer right now. Check back once they're topped up.", code: "out_of_credits" },
      { status: 402 },
    );
  }
  const status = err?.status === 429 ? 429 : 502;
  const message = status === 429 ? "Jev is rate limiting us. Try again in a moment." : "Jev didn't answer. Try again.";
  return Response.json({ error: message }, { status });
}

// The SDK has no dedicated error class for an exhausted balance, so match on
// 402 Payment Required or a billing-related message in any error response.
export function isOutOfCredits(err) {
  if (err?.status === 402) return true;
  if (!err?.status) return false;
  const text = `${err.message ?? ""} ${typeof err.body === "string" ? err.body : JSON.stringify(err.body ?? "")}`;
  return /credit|balance|billing|quota|insufficient funds|payment/i.test(text);
}

export function missingKeyResponse() {
  if (process.env.TYPESAFE_API_KEY || process.env.JEV_MOCK === "1") return null;
  return Response.json({ error: "TYPESAFE_API_KEY is not set on the server." }, { status: 500 });
}
