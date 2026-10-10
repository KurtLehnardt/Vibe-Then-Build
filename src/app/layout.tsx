import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Loop Engine",
  description: "Operator cockpit for brand, outreach, pipeline, delivery, and margin.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="shell">
          <nav className="top">
            <span className="brand">Loop Engine</span>
            <a href="/">Progress</a>
            <a href="/approvals">Approvals</a>
            <a href="/pipeline">Pipeline</a>
            <a href="/brand">Brand</a>
            <a href="/settings">Policy</a>
          </nav>
          {children}
        </div>
      </body>
    </html>
  );
}
