"use client";

// When even the page's frame fails: its own document, in plain styles (the app's styles may not have loaded).
export default function GlobalError({ retry }: { error: unknown; retry: () => void }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#F8FAFC", color: "#0F172B", fontFamily: "Geist, Inter, system-ui, sans-serif" }}>
        <title>Something went wrong · Bike</title>
        <main style={{ textAlign: "center", padding: 24 }}>
          <h1 style={{ margin: 0, fontSize: 28, fontWeight: 600 }}>Something went wrong</h1>
          <p style={{ margin: "12px 0 24px", fontSize: 16, color: "#62748E" }}>Please try again.</p>
          <button type="button" onClick={() => retry()} style={{ height: 40, padding: "0 20px", border: 0, borderRadius: 8, background: "#1E90FF", color: "#fff", fontSize: 16, fontWeight: 500, cursor: "pointer" }}>
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
