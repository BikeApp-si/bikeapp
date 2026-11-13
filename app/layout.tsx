import type { Metadata } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { AuthFooterLinks } from "@/components/auth/auth-footer";
import { edition } from "@/edition";
import "./globals.css";

export const metadata: Metadata = { title: "Bike" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body className="font-sans">
        <AuthFooterLinks links={edition.authFooter()}>{children}</AuthFooterLinks>
      </body>
    </html>
  );
}
