export default function AppLoading() {
  return (
    <div className="flex min-h-[45vh] items-center justify-center p-8" role="status" aria-live="polite">
      <div className="flex items-center gap-3 rounded-xl border border-[#e5ddd0] bg-white px-4 py-3 text-sm font-medium text-[#5a5046] shadow-sm">
        <span className="h-4 w-4 animate-spin rounded-full border-2 border-[#d7cec2] border-t-[#2d2d2d]" aria-hidden="true" />
        Opening page…
      </div>
    </div>
  );
}
