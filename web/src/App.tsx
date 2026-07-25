import { useEffect, useState, type ComponentType, type ReactElement, type SVGProps } from 'react';
import { placeOrder, getStatus } from './api';
import { CONSUMERS, deriveStates, type Consumer, type ConsumerState } from './status';

const META: Record<Consumer, { name: string; sub: string }> = {
  email: { name: 'Email', sub: 'confirmation sent' },
  analytics: { name: 'Analytics', sub: 'metrics recorded' },
  inventory: { name: 'Inventory', sub: 'stock · SQS + DLQ' },
};

const s = (...ch: ReactElement[]) => (p: SVGProps<SVGSVGElement>) =>
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" {...p}>{ch}</svg>;

const CIcon: Record<Consumer, ComponentType<SVGProps<SVGSVGElement>>> = {
  email: s(<rect x="2" y="4" width="20" height="16" rx="2" />, <path d="m2 7 10 6 10-6" />),
  analytics: s(<path d="M3 3v18h18" />, <path d="M8 17v-5" />, <path d="M13 17V8" />, <path d="M18 17v-3" />),
  inventory: s(<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />, <path d="m3.3 7 8.7 5 8.7-5" />, <path d="M12 22V12" />),
};
const Check = s(<circle cx="12" cy="12" r="10" />, <path d="m9 12 2 2 4-4" />);
const Spin = s(<path d="M21 12a9 9 0 1 1-6.22-8.56" />);
const Alert = s(<path d="m21.7 18-8-14a2 2 0 0 0-3.4 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3Z" />, <path d="M12 9v4" />, <path d="M12 17h.01" />);

function StateBadge({ st }: { st: ConsumerState }) {
  if (st === 'done') return <span className="state"><Check /><span>done</span></span>;
  if (st === 'dlq') return <span className="state"><Alert /><span>DLQ</span></span>;
  return <span className="state"><Spin className="spin" /><span>pending</span></span>;
}

export default function App() {
  const [orderId, setOrderId] = useState<string | null>(null);
  const [forceFailure, setForceFailure] = useState(false);
  const [statuses, setStatuses] = useState<Record<string, unknown>>({});
  const [placing, setPlacing] = useState(false);
  const [startTime, setStartTime] = useState(0);
  const [now, setNow] = useState(0);

  async function submit() {
    setPlacing(true); setStatuses({});
    try {
      const { orderId } = await placeOrder([{ sku: 'SKU-1', qty: 2 }], 'buyer@example.com', forceFailure);
      const started = Date.now(); setStartTime(started); setNow(started); setOrderId(orderId);
    } finally { setPlacing(false); }
  }

  useEffect(() => {
    if (!orderId) return;
    const t = setInterval(async () => {
      setStatuses((await getStatus(orderId)).statuses);
      setNow(Date.now());
    }, 2000);
    return () => clearInterval(t);
  }, [orderId]);

  const elapsed = orderId ? now - startTime : 0;
  const states = deriveStates(statuses, forceFailure, elapsed);
  const done = CONSUMERS.filter((c) => states[c] === 'done').length;
  const dlq = states.inventory === 'dlq';
  const allDone = done === 3;

  const hero =
    !orderId ? { t: 'Place an order', p: 'EventBridge fans it out to email, analytics & inventory' }
    : dlq ? { t: 'Order partially failed', p: 'Inventory retried 3× then routed to the DLQ' }
    : allDone ? { t: 'Order complete', p: 'All three consumers reacted independently' }
    : { t: 'Processing order', p: 'Watch the fan-out react in real time' };

  return (
    <main className="wrap">
      <p className="kicker">AWS · event-driven serverless</p>
      <h1>Order <span>flow</span></h1>
      <p className="lede">One order becomes one event. Three independent consumers react, live.</p>

      <section className="hero">
        <div><h2>{hero.t}</h2><p>{hero.p}</p></div>
        <Ring done={done} total={3} />
      </section>

      <div className="controls">
        <button className="btn" onClick={submit} disabled={placing}>{placing ? 'Placing…' : 'Place order'}</button>
        <label className="toggle">
          <input type="checkbox" checked={forceFailure} onChange={(e) => setForceFailure(e.target.checked)} />
          Force inventory failure
        </label>
      </div>

      {orderId && (
        <>
          <p className="flow-label">Fan-out</p>
          <div className="cards" aria-live="polite">
            {CONSUMERS.map((c) => {
              const I = CIcon[c];
              return (
                <div key={c} className={`card ${states[c]}`}>
                  <span className="ic"><I /></span>
                  <div className="meta"><div className="name">{META[c].name}</div><div className="sub">{META[c].sub}</div></div>
                  <StateBadge st={states[c]} />
                </div>
              );
            })}
          </div>
          <p className="foot">Order <code>{orderId.slice(0, 8)}</code> · {allDone ? 'one event → three consumers' : dlq ? 'inventory captured in the DLQ' : 'consumers reacting'}</p>
        </>
      )}
    </main>
  );
}

function Ring({ done, total }: { done: number; total: number }) {
  const r = 28, c = 2 * Math.PI * r, pct = total ? done / total : 0;
  return (
    <svg className="ring" width="78" height="78" viewBox="0 0 78 78" role="img" aria-label={`${done} of ${total} consumers done`}>
      <circle cx="39" cy="39" r={r} fill="none" stroke="rgba(255,255,255,.22)" strokeWidth="9" />
      <circle cx="39" cy="39" r={r} fill="none" stroke="var(--amber)" strokeWidth="9" strokeLinecap="round"
        strokeDasharray={c} strokeDashoffset={c * (1 - pct)} transform="rotate(-90 39 39)"
        style={{ transition: 'stroke-dashoffset .5s ease' }} />
      <text x="39" y="45" textAnchor="middle" fontSize="18" fontWeight="700" fill="#fff">{done}/{total}</text>
    </svg>
  );
}
