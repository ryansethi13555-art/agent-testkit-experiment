// How MoneyInvariant drives QueueBazaar's API (see docs/QUICKSTART.md).

export async function create_order(args, app) {
  const response = await app.post("/orders", {
    buyer: "buyer_1",
    currency: args.currency ?? "INR",
    lines: args.lines,
    capture: args.capture,
  });
  return { order_id: response.body.id, line_ids: response.body.lines, response };
}

export async function checkout(args, app) {
  return app.post(`/orders/${args.order_id}/checkout`);
}

export async function confirm(args, app) {
  return app.post(`/orders/${args.order_id}/confirm`);
}

export async function capture(args, app) {
  return app.post(`/orders/${args.order_id}/capture`);
}

export async function refund_line(args, app) {
  return app.post(`/orders/${args.order_id}/refunds`, { line_id: args.line_id, amount: args.amount });
}
