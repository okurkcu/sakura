export interface OrderItem {
  sku: string;
  name: string;
  quantity: number;
  unitPrice: number;
}

export interface Order {
  id: string;
  placedAt: string;
  items: OrderItem[];
}

const ORDERS: Order[] = [
  {
    id: 'ord_1001',
    placedAt: '2026-01-05T09:30:00.000Z',
    items: [{ sku: 'mug-01', name: 'Coffee mug', quantity: 2, unitPrice: 12.5 }],
  },
  {
    id: 'ord_1002',
    placedAt: '2026-01-07T14:10:00.000Z',
    items: [
      { sku: 'tee-02', name: 'T-shirt', quantity: 1, unitPrice: 25 },
      { sku: 'cap-03', name: 'Cap', quantity: 1, unitPrice: 17.5 },
    ],
  },
];

export function listOrders(): Order[] {
  return ORDERS;
}

export function getLatestOrder(): Order {
  const latest = ORDERS[ORDERS.length - 1];
  if (latest === undefined) {
    throw new Error('No orders');
  }
  return latest;
}

export function orderTotal(order: Order): number {
  return order.items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);
}

export function formatMoney(amount: number): string {
  return `$${amount.toFixed(2)}`;
}
