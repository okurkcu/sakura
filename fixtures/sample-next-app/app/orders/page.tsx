import { formatMoney, listOrders, orderTotal } from '@/lib/orders';

export default function OrdersPage() {
  return (
    <>
      <h1>Orders</h1>
      <ul>
        {listOrders().map((order) => (
          <li key={order.id}>
            {order.id}: {formatMoney(orderTotal(order))}
          </li>
        ))}
      </ul>
    </>
  );
}
