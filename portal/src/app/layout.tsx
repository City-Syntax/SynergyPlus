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
    <html lang="en">
      <body className="min-h-screen text-body-normal antialiased">{children}</body>
    </html>
  );
}
