import type { Metadata } from "next";
import { AccessProvider } from '@/components/access/AccessProvider';
import { TallyStatusProvider } from '@/components/tally/TallyStatusProvider';
import { PersistentAppShell } from '@/components/dashboard/PersistentAppShell';

import "@fontsource/poppins/latin-400.css";
import "@fontsource/poppins/devanagari-400.css";
import "@fontsource/poppins/latin-500.css";
import "@fontsource/poppins/devanagari-500.css";
import "@fontsource/poppins/latin-600.css";
import "@fontsource/poppins/devanagari-600.css";
import "@fontsource/poppins/latin-700.css";
import "@fontsource/poppins/devanagari-700.css";
import "@fontsource/poppins/latin-800.css";
import "@fontsource/poppins/devanagari-800.css";
import "@fontsource/poppins/latin-900.css";
import "@fontsource/poppins/devanagari-900.css";
import "@fontsource/jetbrains-mono/latin-400.css";
import "@fontsource/jetbrains-mono/latin-500.css";
import "@fontsource/jetbrains-mono/latin-600.css";
import "@fontsource/jetbrains-mono/latin-700.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "Procurement Packet Comparator",
  description: "Secure document intake, comparison, and mismatch review for client billing packets.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased"><AccessProvider><TallyStatusProvider><PersistentAppShell>{children}</PersistentAppShell></TallyStatusProvider></AccessProvider></body>
    </html>
  );
}
