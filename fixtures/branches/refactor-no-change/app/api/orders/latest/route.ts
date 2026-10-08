import { calculateOrderTotal, findLatestOrder } from '@/lib/order-repository';

export function GET() {
  const order = findLatestOrder();
  return Response.json({
    id: order.id,
    placedAt: order.placedAt,
    total: calculateOrderTotal(order),
    items: order.items,
  });
}
