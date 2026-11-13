// While a page loads (a click in the sidebar, before the server answers): the header's shape and a few table
// rows, as quiet placeholders, so the old page doesn't stay on screen. No words; screen readers hear "Loading".
export function PageLoading() {
  const bar = "rounded-[6px] bg-fill";
  return (
    <div role="status" aria-label="Loading" aria-busy="true" className="flex min-h-0 flex-1 flex-col motion-safe:animate-pulse">
      <div className="flex h-12 shrink-0 items-center border-b border-line px-6">
        <span className={`${bar} h-4 w-48`} />
      </div>
      <div className="flex flex-col gap-2 px-8 pt-6">
        <span className={`${bar} h-6 w-56`} />
        <span className={`${bar} h-3.5 w-72`} />
      </div>
      <div className="flex flex-col gap-0 px-8 pt-5">
        <span className={`${bar} mb-5 h-8 w-56`} />
        {Array.from({ length: 7 }, (_, i) => (
          <div key={i} className="flex gap-6 border-b border-fill py-3.5">
            <span className={`${bar} h-4 w-[22%]`} />
            <span className={`${bar} h-4 w-[18%]`} />
            <span className={`${bar} h-4 w-[14%]`} />
            <span className={`${bar} h-4 w-[20%]`} />
          </div>
        ))}
      </div>
    </div>
  );
}
