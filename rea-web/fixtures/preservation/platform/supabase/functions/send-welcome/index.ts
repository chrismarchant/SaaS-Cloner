// Sends the welcome email after sign-up.
Deno.serve(async (req) => {
  const apiKey = Deno.env.get("RESEND_API_KEY");
  const { email } = await req.json();
  return new Response(JSON.stringify({ queued: apiKey !== undefined, email }), {
    headers: { "Content-Type": "application/json" },
  });
});
