import { calculateOrderTotal, findLatestOrder, formatMoney } from '@/lib/order-repository';

// Rendered on every request: the time and visitor number differ each time on purpose, so this page
// exercises bdiff's noise filter.
export const dynamic = 'force-dynamic';

export default function DashboardPage() {
  const latest = findLatestOrder();
  const visitor = Math.floor(Math.random() * 1_000_000);
  return (
    <>
      <h1>Dashboard</h1>
      <p>Server time: {new Date().toISOString()}</p>
      <p>Visitor #{visitor}</p>
      <p>
        Latest order {latest.id}: {formatMoney(calculateOrderTotal(latest))}
      </p>
    </>
  );
}
