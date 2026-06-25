import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "SynergyPlus — Developer Portal",
  description:
    "Manage API keys and run EnergyPlus simulations on the SynergyPlus platform.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
