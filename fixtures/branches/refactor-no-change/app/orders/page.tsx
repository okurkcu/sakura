import { calculateOrderTotal, findAllOrders, formatMoney } from '@/lib/order-repository';

export default function OrdersPage() {
  return (
    <>
      <h1>Orders</h1>
      <ul>
        {findAllOrders().map((order) => (
          <li key={order.id}>
            {order.id}: {formatMoney(calculateOrderTotal(order))}
          </li>
        ))}
      </ul>
    </>
  );
}
