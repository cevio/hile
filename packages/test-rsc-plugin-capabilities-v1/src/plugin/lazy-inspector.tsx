'use client';

export default function LazyInspector({ buildId }: { buildId: string }) {
  return (
    <aside className="capability-lazy" data-testid="lazy-inspector">
      Lazy client chunk loaded independently for build <strong>{buildId}</strong>.
    </aside>
  );
}
