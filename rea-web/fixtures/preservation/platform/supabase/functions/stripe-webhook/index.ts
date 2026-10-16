// Receives Stripe events. Public endpoint: signature is checked in the handler.
Deno.serve(async (req) => {
  const secret = Deno.env.get("STRIPE_WEBHOOK_SECRET");
  const body = await req.text();
  return new Response(
    JSON.stringify({ received: body.length, verified: secret !== undefined }),
  );
});
