import type { Metadata } from "next";
import "./globals.css";
import { Shell } from "@/components/shell";
import { ToastProvider } from "@/components/toast";

export const metadata: Metadata = {
  title: "AgentPay Console",
  description:
    "Enforcement and audit layer for autonomous agent payments on Solana.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="antialiased">
        <ToastProvider>
          <Shell>{children}</Shell>
        </ToastProvider>
      </body>
    </html>
  );
}
