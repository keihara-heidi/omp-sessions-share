import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Geist, Geist_Mono } from "next/font/google";
import { cn } from "@/lib/utils";
import { Toaster } from "@/components/ui/sonner";
import Providers from "./providers";

const geist = Geist({ subsets: ["latin"], variable: "--font-sans" });
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-mono" });

export const metadata: Metadata = {
  title: "OMP Sessions",
  description: "Join live OMP collab sessions on this Mac",
};

export const viewport: Viewport = {
  themeColor: "#0f0b14",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={cn("dark font-sans", geist.variable, geistMono.variable)}>
      <body>
        <Providers>{children}</Providers>
        <Toaster
          mobileOffset={{
            bottom: "calc(5rem + env(safe-area-inset-bottom))",
          }}
        />
      </body>
    </html>
  );
}
