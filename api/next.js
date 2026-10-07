import { MAX_LENGTH, nextCharacter } from "../lib/jev.js";

const MAX_QUESTION = 2000;

export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Body must be JSON." }, { status: 400 });
  }

  const question = typeof body?.question === "string" ? body.question.trim() : "";
  const answer = typeof body?.answer === "string" ? body.answer : null;
  if (!question || question.length > MAX_QUESTION) {
    return Response.json({ error: `Question must be 1–${MAX_QUESTION} characters.` }, { status: 400 });
  }
  if (answer === null || answer.length >= MAX_LENGTH || !/^[A-Z ]*$/.test(answer)) {
    return Response.json({ error: "Invalid answer so far." }, { status: 400 });
  }
  if (!process.env.TYPESAFE_API_KEY && process.env.JEV_MOCK !== "1") {
    return Response.json({ error: "TYPESAFE_API_KEY is not set on the server." }, { status: 500 });
  }

  try {
    return Response.json(await nextCharacter(question, answer));
  } catch (err) {
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
}

// The SDK has no dedicated error class for an exhausted balance, so match on
// 402 Payment Required or a billing-related message in any error response.
function isOutOfCredits(err) {
  if (err?.status === 402) return true;
  if (!err?.status) return false;
  const text = `${err.message ?? ""} ${typeof err.body === "string" ? err.body : JSON.stringify(err.body ?? "")}`;
  return /credit|balance|billing|quota|insufficient funds|payment/i.test(text);
}
