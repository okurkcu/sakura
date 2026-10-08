import { getLatestOrder, orderTotal } from '@/lib/orders';

export function GET() {
  const order = getLatestOrder();
  return Response.json({
    id: order.id,
    placedAt: order.placedAt,
    total: orderTotal(order),
    items: order.items,
  });
}
