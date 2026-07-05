export function Header({ right }: { right?: React.ReactNode }) {
  return (
    <header className="flex items-center justify-between px-8 py-5 bg-white border-b border-slate-200">
      <div className="flex items-center gap-2">
        <span className="text-2xl">🧠</span>
        <span className="text-lg font-bold text-slate-900">
          Neuro<span className="text-red-600">Seller</span>
        </span>
      </div>
      {right}
    </header>
  );
}
